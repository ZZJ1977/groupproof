# 成员 C：任务执行接口与 B / D 交接

本批实现 C2-01、C2-03、C2-04、C2-08 的 canonical FastAPI 后端，代码位于 `services/api/app/modules/c/`。实际持久化使用 `app.db.models` 的 `Task`、`TaskAssignee`、`TaskDependency`、`ProgressEvent`、`FunctionalModule`、`PlanVersion` 和现有项目/课程关系；不使用 `server/` 的另一套身份或数据模型。

## 已实现的边界

- 所有读取先检查当前项目成员或所属课程教师/助教关系。管理员全局角色不提供项目内容访问权限；离组的历史组长没有特权。
- 所有写入要求真实身份的 `email_verified_at` 非空；未验证邮箱可以按原有权限读取，但不能开始任务、更新进度或进行内部状态变更。共享项目写权限入口也检查此条件，供证据和说明服务复用。
- 写入要求项目 active、课程 active、项目基线 frozen，且**最新** `PlanVersion` 为 frozen。任务必须存在于该版本 `snapshot_json.tasks` 中。当前 canonical seed 的快照使用任务 UUID 字符串数组，也接受带 `id` 的任务对象。
- 最新计划缺失、草稿、仅 confirmed 或 archived 均拒绝执行。旧版 frozen 不会掩盖新版草稿。成员确认对应哪个版本、任务内容是否与该冻结版本一致，仍由 B 的发布/冻结流程负责；C 不自行生成成员确认或重新冻结计划。
- 只有当前 responsible 负责人可以开始任务；组长不能代替其他负责人开始。开始前所有阻塞依赖必须 completed，缺失或跨项目依赖不会被当作已完成。
- 成功开始后的重复请求返回当前状态，不增加版本和事件；权限、项目、课程和计划状态仍重新校验。
- 负责人或当前组长可更新叶任务进度，要求整数 0–100、非空原因和匹配的乐观锁版本。只允许 in_progress / pending_submission 状态。父任务进度通过子任务权重计算，不能手动覆盖。
- 100% 进度保持当前状态，不自动提交或完成。正式 completed 只能经内部可信适配器授权；完成时进度置 100，并与状态、时间、汇总和事件一起提交。父任务完成前，其直接子任务必须 completed 且派生进度为 100。
- 父任务逐层加权，项目只计算根任务，避免父子重复计数。模块计算没有同模块祖先的任务，可处理 canonical seed 中“父子任务处于不同模块”的情况。现有 `Project` 没有进度列，项目进度实时计算返回；不会自行扩展 B 的表字段。
- 写入使用真实 SQLAlchemy 事务，先锁项目，再锁相关课程/成员/计划与项目任务，任务按 UUID 顺序锁定。失败回滚任务、模块汇总和 ProgressEvent。

## HTTP 契约

由统一业务 router 挂载到 `/api/v1`：

| 方法 | 路径 | 请求 | 行为 |
| --- | --- | --- | --- |
| GET | `/api/v1/tasks/{task_id}/execution` | 无 | 执行状态、负责人、依赖、版本、项目/模块进度、当前操作能力 |
| POST | `/api/v1/tasks/{task_id}/start` | `expected_version` | 负责人开始任务；成功重试幂等 |
| PATCH | `/api/v1/tasks/{task_id}/progress` | `expected_version`、`progress`、`reason` | 更新叶任务进度并汇总 |
| POST | `/api/v1/tasks/{task_id}/prepare-submission` | `expected_version`、可选 `note`，必需 `Idempotency-Key` 头 | 原子保存实施说明草稿并进入待提交，供前端跳 D16 检查 |

`execution_router.py` 自身只有 `/tasks` 前缀；不要重复挂载旧 `/api/c` 业务路径。`/api/c/ready` 的就绪探针由现有模块 router 保留。

开始任务请求：

```json
{"expected_version": 0}
```

更新进度请求：

```json
{"expected_version": 1, "progress": 80, "reason": "已完成核心执行流程，剩余边界验证"}
```

请求体禁止额外字段，不能提供 actor_id、角色或目标 status。成功响应沿用 `{data, meta: {request_id}}`，并设置 `Cache-Control: private, no-store`。数据包括：

```json
{
  "task_id": "任务 UUID",
  "project_id": "项目 UUID",
  "status": "in_progress",
  "progress": 80,
  "version": 2,
  "started_at": "带时区的开始时间",
  "completed_at": null,
  "responsible_ids": ["负责人 UUID"],
  "dependencies": [],
  "project_progress": 53,
  "module_progress": {"模块 UUID": 53},
  "can_start": false,
  "can_update_progress": true,
  "read_only": false
}
```

上例是字段说明，UUID/时间须使用真实合法值。`read_only` 表示项目、课程或计划的执行限制；具体用户是否可以操作，以 `can_start` / `can_update_progress` 为准。空模块进度为 null。

常见错误：401 未认证；403 跨项目/非负责人/只读课程或项目；404 任务不存在；409 版本冲突、依赖未完成、计划未冻结、任务未确认或非法状态；422 字段或原因校验失败。错误使用现有 `error.code / message / details` 与 request_id 契约。

身份继续复用 `app.api.auth.get_current_user`。当前 canonical A 认证只支持显式 development/test 环境的 demo 身份；生产环境保持 401，即使提交 demo header 也无法绕过。此批没有新增身份头、角色选择器或生产认证替代方案。

## 内部状态函数与交接要求

`TaskExecutionService` 提供 `change_task_status`、`mark_completed`、`return_to_in_progress`。没有对浏览器开放任意状态修改接口。

状态边：not_started → in_progress；in_progress → pending_submission；pending_submission → pending_verification 或 in_progress；pending_verification → completed 或 in_progress；completed → in_progress。

not_started → in_progress 复用负责人/依赖开始规则。通用内部状态变更接口的其余转换必须传入进程内 `TransitionProvider`；缺少适配器返回 503 `TRANSITION_PROVIDER_UNAVAILABLE`。C2-08 的专用准备端点在同事务保存草稿后进入 pending_submission，不执行 D 验收。该协议的 `authorize(scope, user, target, reason)` 必须读取当前持久化事实，验证对应流程条件，并将必要的失效通知/记录写入**同一 Session 和事务**。不得信任浏览器传来的 `verified=true`、AI 通过结果或陈旧验证快照。

调用形态如下（`DTransitionAdapter` 是待 D 交付的实际适配器，不是本批已实现类）：

```python
service = TaskExecutionService(SqlExecutionRepository(session))
adapter = DTransitionAdapter(session=session)
view = service.mark_completed(
    task_id, authenticated_user, expected_version, "人工确认当前验证结果",
    provider=adapter,
)
```

- B 负责冻结版本、成员确认绑定版本、计划快照结构以及任务规划字段。B 解锁/生成新计划时需遵循“先锁同一 Project 行”的事务顺序，才能与 C 的执行写入串行；C 不改标题、任务树、权重或责任分配。
- C2-08 保存草稿并进入 pending_submission，返回任务 ID 供前端跳转 D16；说明/证据缺项与标准覆盖由 D1-01 检查。C 不运行正式完整性检查、不创建验证任务或验收结果。
- D 负责当前验证结果、人工确认、验收结论与失效处理。完成和退回均需要可信适配器；C 不创建或伪造 D 结果表。
- 适配器不得单独 commit。当前 `TaskExecutionService` 在授权、状态/进度/汇总、事件全部成功后统一 commit；调用者必须使用专用请求事务，避免夹带无关未提交写入。

## 验证记录

### C2-08 准备提交契约

原文操作“检查完整性”对应“保存草稿，任务变成待提交，跳到 D 的 16 页”；持久化成功后离开页面再返回仍可读到草稿。该端点只允许当前 responsible 负责人使用，复用已验证邮箱、项目/课程只读和最新冻结计划规则。

请求示例（`Idempotency-Key` 由客户端为本次保存生成，重试必须沿用）：

```json
{
  "expected_version": 3,
  "note": {
    "expected_version": 1,
    "title": "实施说明",
    "body": "已实现核心流程，待补充边界测试证据。"
  }
}
```

外层版本是任务版本，内层是已有说明的 `lock_version`（首次保存为 0）。`note` 缺省或 null 时保留已有说明，不新建说明版本；完全没有说明或证据也允许进入 D16，让 D 检查缺项。有说明时沿用非空标题/正文校验，不把空白正文悄悄解释成删除。

成功返回 `{execution, note}`，其中 `execution` 为本文执行 DTO，包含 `task_id`；`note` 为现有说明 DTO 或 null。前端依据任务 ID 跳转 D16，不传入或接受客户端跳转 URL。任务进度保持原值，包括 0 或 100；状态只到 pending_submission，不会成为 pending_verification/completed。

同一事务复用 `save_note`，保存说明新版本及来源失效事件，修改任务状态/版本，记录 ProgressEvent、`task.submission_prepared` outbox 和幂等响应。失败全部回滚，包括已存在正式证据的说明来源失效标记。重复同键同内容返回原响应，不产生重复说明或事件；同键不同内容、陈旧任务版本、陈旧说明版本均返回 409。重放前仍重新检查当前成员、负责人、邮箱、计划与只读限制；D 已推进任务时重放不会把任务倒退。

新增 `tests/test_c_submission.py` 使用真实关系存储验证保存、权限、版本冲突、原子回滚与 HTTP 契约，另以 PostgreSQL 隔离 schema 验证同键/不同键并发保存。

C2-08 增量验证：`test_c_submission.py`、`test_c_execution.py`、`test_c_execution_postgres.py`、`test_c_notes.py` 在独立 PostgreSQL 测试库运行 **137 passed，0 skipped，54.46 秒**，其中提交准备新增 32 项全部通过（含 2 项并发）。初次 PG 运行发现全表事件数量断言受既有 seed 事件影响，已将提交准备 fixture 改为唯一 schema 后复跑通过；未改变业务规则来迁就测试。

本批当前执行：

- 初次无数据库运行执行模块：**92 passed，4 skipped**。随后在独立 PostgreSQL 16 / pgvector 测试容器中，设置三个测试数据库变量运行全 API 测试：**175 passed，0 skipped，65.88 秒**；只有已有 Starlette / AnyIO 弃用警告。执行模块的四个真实 PostgreSQL 测试全部通过。
- 六个新增执行源文件/测试文件的 Ruff check 与 format 检查通过。
- HTTP / 服务单测使用明确命名的 `MemoryRepository` 测试替身，覆盖跨项目、角色、生命周期、冻结计划、快照成员、乐观锁、幂等开始、依赖、100% 不完成、汇总、事务失败、可信适配器和生产认证关闭。
- 四个 PostgreSQL 测试实际验证了持久化、外键失败回滚、并发兄弟任务汇总、活动成员/课程权限；证据与说明的三项 PostgreSQL 并发测试也通过。
- 空测试库执行 `alembic upgrade head`，0001–0007 全部成功；`alembic check` 无模型差异。随后在同一独立测试库完成 `downgrade 0006` → `upgrade head`，再次 `alembic check` 无差异。未修改其他容器或数据库。

PostgreSQL 测试只接受显式提供的本地测试库，每项创建唯一 `c_execution_test_<uuid>` schema，完成后删除该 schema；不修改共享表。测试使用 ORM 建表验证 repository，Alembic 迁移验证仍由 `tests/test_database.py` 和实际迁移命令完成。运行时设置 `C_EXECUTION_TEST_DATABASE_URL` 为本地 PostgreSQL+psycopg URL，并执行上述 pytest 命令。
