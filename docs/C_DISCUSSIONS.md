# C6 讨论、并发回复与重要来源交接

本文对应 C6-01/02/03，记录 `services/api/app/modules/c/discussion_*.py` 的真实数据库实现。证据生命周期见 [C_EVIDENCE.md](C_EVIDENCE.md)，权限背景见 [C_TASK_EXECUTION.md](C_TASK_EXECUTION.md)，关系字段依据 [ERD.md](ERD.md)。前端 Mock 和真实 HTTP 接入状态应在 [C_DELIVERY.md](C_DELIVERY.md) 分开说明。

已实现同项目对象关联、创建讨论、独立回复行、结构化提及、重要标记、不可变讨论来源快照、幂等与并发保护。通知和审计写入 C 的事务 outbox；尚未接入 A 的通知送达，不把 pending 当作已发送。

## 1. HTTP 接口

路径均相对于 `/api/v1`，身份来自 canonical `get_current_user`，不接受请求体指定作者或角色。所有资源 ID 为 UUID；写请求必须携带 `Idempotency-Key`。成功返回 `data/meta.request_id`，错误返回统一 `error/meta`；受保护的成功和错误响应均为 `Cache-Control: private, no-store`。

| 方法与路径 | 输入 | 返回 |
|---|---|---|
| `GET /projects/{project_id}/discussions` | `page`、`page_size`，可选 `task_id/requirement_id/module_id/milestone_id/is_important/q` | `DiscussionPageDTO`：`items/page/page_size/total` |
| `POST /projects/{project_id}/discussions` | `title`、`body`；可选四类对象 ID、`mention_user_ids`；`expected_version` 初始为 0，可省略 | 201，`DiscussionDTO` |
| `GET /projects/{project_id}/discussions/{discussion_id}` | 无 | `DiscussionDTO`，含回复数、重要标记、锁版本和来源快照 ID |
| `GET /projects/{project_id}/discussions/{discussion_id}/replies` | `page`、`page_size` | `DiscussionRepliesPageDTO`，含 `discussion_lock_version` |
| `POST /projects/{project_id}/discussions/{discussion_id}/replies` | `expected_version`、`body`、可选 `mention_user_ids` | 201，`{discussion, reply}` |
| `PUT /projects/{project_id}/discussions/{discussion_id}/important` | `expected_version`、布尔值 `is_important`、必填 `reason` | 更新后的 `DiscussionDTO` |

分页从 1 开始，`page_size` 最大 100；讨论列表默认 20，回复列表默认 50。筛选先于分页。关键词查询标题和正文，最大 200 字符；讨论标题最大 240，正文和回复最大 30000，标重要/取消原因最大 4000。空白正文、空白原因、重复提及和额外身份字段均拒绝。

四类对象可以同时关联，但每个必须存在于路径指定的项目。这里只要求项目归属一致，不推测或重写任务、需求、模块和里程碑之间的业务关系。关联对象 ID 跨项目返回 `DISCUSSION_LINK_MISMATCH`；跨项目讨论 ID 返回 `DISCUSSION_NOT_FOUND`。

## 2. 权限与可写条件

读取允许本项目活跃学生成员、所属课程教师及活跃助教。创建和回复允许本项目活跃学生成员或所属教师；重要标记只允许讨论作者、本项目组长或所属教师。助教默认只读，平台管理员身份不会自动授予项目内容权限，其他课程教师或同课程其他小组不能越权。

所有写入复用 `get_project_access(..., lock=True)` 检查账号 active、邮箱已验证和真实项目/课程关系；还要求项目 active、所属课程 active。讨论服务于规划阶段，因此不要求基线或任务计划已经冻结，也不限制关联任务必须正在执行。

当前讨论创建后为 `open`。数据库保留 `closed` 状态以供后续治理接口使用；本批没有关闭、删除、改写原文或修改旧回复的 API。关闭讨论拒绝新增回复和重要标记。

## 3. 并发回复为什么不会覆盖

回复存放在 `discussion_replies` 的独立行，服务端分配回复 UUID。没有把整个回复数组从浏览器覆盖回父讨论的操作。

父讨论 `lock_version` 代表主题元信息版本，例如重要状态。回复请求的 `expected_version` 校验这个版本，但追加回复本身不修改父版本。因此两个读到相同父版本的合法回复可以都成功，分别留下自己的作者、正文、时间、提及和 outbox 事件。

重要标记用数据库条件更新 `WHERE id = ... AND lock_version = expected_version`，成功递增父版本；旧页面在重要状态变化后回复或再次标记会得到 `409 VERSION_CONFLICT`，必须刷新核对。重要标记与回复写入仍持有项目级数据库锁，重要来源的完整快照按提交顺序捕获，避免漏掉另一条已提交回复。

回复总数由数据库聚合，`last_activity_at` 由主题更新时间和最新回复时间计算。持久化父行的 `updated_at` 是主题元信息更新时间，不用它冒充回复总版本。回复列表默认按创建时间和 UUID 稳定排序。

独立的新命令使用新的 `Idempotency-Key`。同 actor/project/operation/key、同请求重放原成功结果；换请求内容复用 key 返回 `IDEMPOTENCY_CONFLICT`。幂等重试可能返回首次响应时的回复总数，读取最新数量应重新 GET，而不是期待重试改变原结果。

## 4. 提及与待投递通知

提及由 `mention_user_ids` 表达并独立存储，最多 50 人且不能重复。服务端验证目标现在仍有项目内容读取资格，包括本项目活跃成员和所属课程活跃教师/助教；仅在正文输入一个用户名不会绕过此校验或自动通知任意用户。

创建讨论会为除作者外的当前项目成员、以及合法提及对象写通知请求；回复会为仍有读取权限的主题作者、以及合法提及对象写请求。接收人集合去重，不通知当前操作人自己。提及通知优先标记为 `discussion_mentioned`，其余分别为 `discussion_created` 或 `discussion_replied`。

这些请求是 `c_integration_outbox` 中 `notification.requested` 事件，包含 `recipient_id`、真实 `actor_id`、项目与讨论目标 ID、可选回复 ID、通知类型、标题和 `delivery_status="pending"`。`delivered_at` 为空；没有发送邮件、调用外部账号、假造 `notifications` 表送达状态或创建虚构的前端 URL。

A 消费时仍须重新检查收件人的当前权限，防止成员退出后收到受限内容；实际通知路由和渠道由 A 的正式契约决定。消费者需按 outbox 事件 ID 去重，真实处理后再确认送达。

## 5. 重要讨论作为证据来源

标为重要时写入一份完整且不可变的 `discussion_source_snapshots`：主题、同项目关联、作者、正文、结构化提及、当前所有回复、回复数、父锁版本和内容散列。每份来源快照有自己的 UUID 与递增 `version_no`。

`DiscussionDTO.evidence_source_id` 是稳定的讨论 UUID；`source_snapshot_id` 是最新不可变快照 UUID。新增回复会追加快照，取消重要也会追加记录资格变化的快照；先前快照从不覆盖。曾有重要快照的讨论，取消重要后的后续回复也继续保留新来源版本。

只读内部适配入口：

```python
resolve_discussion_source(
    session,
    current_user,
    project_id,
    discussion_id,
    require_important=True,
) -> VerifiedSource
```

它验证真实访问资格和项目归属，返回 `source_type="discussion"`、`identity=discussion UUID`、`revision=不可变快照 UUID` 与服务器读取的快照正文。新候选必须保持默认 `require_important=True`；普通讨论和取消重要的讨论返回 `DISCUSSION_NOT_IMPORTANT`，不能靠客户端传“重要”字段提升资格。

根装配已把该 resolver 接入证据创建：请求 `source_type="discussion"`、`source_id=讨论 UUID`、真实任务 ID 和至少一个同任务验收标准 ID。最终仍产生候选，需要证据服务自己的权限、任务状态、冻结计划和人工采纳检查；标重要不会直接生成正式证据。

已有证据的本地失效处理可以用 `require_important=False` 读取资格撤销快照。它不允许将普通讨论创建成新证据，只服务于保留旧来源并标记变化。

## 6. 同事务变化与 outbox

新回复或重要资格变化会追加 `discussion.source_changed` 待消费事件，包含来源 ID、当前快照 revision、当前是否允许作为新证据来源、真实操作人和原因。

在 C 内部，重要讨论变化后的已有证据不能等待外部通知送达才失效。服务在新快照写入后调用根装配的 `discussion_evidence.invalidate_discussion_evidence`，同一事务追加证据来源变化历史并设 `source_changed=true`；有效证据查询立即排除旧来源，原正式状态及原快照保留。B/D 后续验收失效或贡献重算仍通过待消费事件对接，尚未宣称已经完成。

事务内的事件还包括：

| 事件 | 用途 |
|---|---|
| `discussion.created` | 新讨论审计，包含实际作者与提及 ID |
| `discussion.reply_added` | 新回复审计，包含实际回复者和回复 ID |
| `discussion.importance_changed` | 重要资格决策，包含原因、锁版本和来源 revision |
| `discussion.source_changed` | 来源变更交接，供下游重新评估 |
| `notification.requested` | A 通知待办请求，尚未送达 |
| `evidence.source_changed` | 已引用该讨论的证据在本地失效，由证据服务产生 |

讨论、回复、提及、来源快照、相关证据失效、审计/通知 outbox 和幂等结果统一提交。任一环节失败整体回滚，不留下“已回复但未记录事件”或“通知请求成功但正文失败”的部分结果。服务函数不自行 commit；HTTP 复用 `commit_command`，其他内部调用方必须提供同样的事务边界。

## 7. 调用例子

下面 UUID 仅说明格式，需要替换为同项目真实 ID，并携带 A 接入后的认证上下文。生产环境不能用示例身份头替代会话。

```http
POST /api/v1/projects/11111111-1111-4111-8111-111111111111/discussions
Content-Type: application/json
Idempotency-Key: discussion-create-001

{
  "title": "证据归档方式讨论",
  "body": "建议保留原始来源快照，并记录后续变化。",
  "task_id": "22222222-2222-4222-8222-222222222222",
  "mention_user_ids": ["33333333-3333-4333-8333-333333333333"]
}
```

```http
POST /api/v1/projects/11111111-1111-4111-8111-111111111111/discussions/44444444-4444-4444-8444-444444444444/replies
Content-Type: application/json
Idempotency-Key: discussion-reply-001

{"expected_version": 0, "body": "同意，并补充来源变更的审计记录。", "mention_user_ids": []}
```

```http
PUT /api/v1/projects/11111111-1111-4111-8111-111111111111/discussions/44444444-4444-4444-8444-444444444444/important
Content-Type: application/json
Idempotency-Key: discussion-important-001

{"expected_version": 0, "is_important": true, "reason": "已形成实现决策，供关联任务引用。"}
```

前端取消编写时只需丢弃尚未提交的输入；服务端不会在用户真正提交前创建“草稿讨论”。如需要离开确认，应由页面实现，不调用创建接口假装保存。

## 8. 模型、迁移与回退

`0008_c_discussions.py` 前置 `0007`，静态创建五张表：

| 表 | 说明 |
|---|---|
| `discussions` | 对齐 ERD 主题字段、四类可空关联、重要状态、开放状态和乐观锁 |
| `discussion_replies` | 对齐 ERD 回复实体，独立子行避免覆盖并发回复 |
| `discussion_mentions` | 新增：主题提及关系，组合主键去重 |
| `discussion_reply_mentions` | 新增：回复提及关系，组合主键去重 |
| `discussion_source_snapshots` | 新增：完整不可变来源版本；同讨论版本号唯一 |

迁移同时扩展 `evidence.ck_evidence_source_type`，加入 `discussion`。没有修改旧迁移，也没有创建与 A 重复的通知投递表。根 metadata 与 Alembic env 必须注册 `discussion_models`，否则自动差异检查可能误判这些表。

**仅空讨论表可回退 0008。** 降级首先检查讨论来源证据，以及任意讨论、回复、提及或来源快照业务数据；存在数据就明确抛错并中止，未转换为证据的讨论同样受到保护。需要降级时先导出、验证备份，并制定实际的数据迁移方案；脚本不会替用户静默删除历史、改来源类型或冒充已经完成数据迁移。

## 9. 验证命令与边界

关系/HTTP 测试位于 `tests/test_c_discussions.py` 与 `tests/test_c_discussions_http.py`。不配置 `C_TEST_DATABASE_URL` 时使用测试专用 SQLite，包含真实 SQLAlchemy 关系与事务回滚，但不代表 PostgreSQL 行锁或迁移已验证。

`tests/test_c_discussions_postgres.py` 使用独立 UUID schema 测试真实 PG：同父版本双回复均持久化、相同请求重试不重复回复/通知、重要操作的版本竞争，以及存在未转证据讨论时拒绝降级且保留数据。该测试不接外部账号。

在专用本地测试 PostgreSQL 上配置 `DATABASE_URL`、`C_TEST_DATABASE_URL`、`C_EXECUTION_TEST_DATABASE_URL`，三者指向同一测试库；不要使用生产库。Windows 的 FastAPI TestClient 可能需要允许本地异步测试运行环境。

```powershell
# 工作目录：services/api；先设置上面的测试数据库变量。
.venv/Scripts/python.exe -m alembic upgrade head
.venv/Scripts/python.exe -m alembic check
.venv/Scripts/python.exe -m pytest tests/test_c_discussions.py tests/test_c_discussions_http.py tests/test_c_discussions_postgres.py -q
.venv/Scripts/ruff.exe check app/modules/c/discussion_*.py tests/test_c_discussions*.py migrations/versions/0008_c_discussions.py
```

全套集成结果在 C 交付记录中统一维护。真实边界仍是：生产 A 会话未接入时请求默认拒绝；A 通知只有待消费 outbox，未送达；B/D 自动验收失效与贡献更新仍待消费者；前端若仍运行 Mock，应保留明确标识，不能把 Mock 讨论、通知或证据当作真实数据库结果。
