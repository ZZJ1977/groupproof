# C 证据与任务说明接口交接

本文件记录 `services/api` 中已经实现的 C2/C3 证据与任务说明后端。任务执行状态接口另见 [C_TASK_EXECUTION.md](C_TASK_EXECUTION.md)，总体交付边界见 [C_DELIVERY.md](C_DELIVERY.md)，数据关系依据 [ERD.md](ERD.md)。

实现包含手工证据、任务说明版本转候选、采纳、撤回、来源变化历史、有效证据查询、说明版本管理及事务 outbox。A 文件存储、GitHub/飞书真实来源适配器、A 生产会话和 B/D 事件消费尚未完成接入；接口不会为这些依赖制造成功结果。

## 1. 入口与公共契约

- 根路径：`/api/v1`。健康检查 `/api/c/ready` 不代表鉴权、数据库或第三方服务已就绪。
- 身份：统一 `Depends(get_current_user)`；请求体不接受 `actor_id`、`author_id`、角色、证据状态等越权字段。
- 资源 ID：UUID。前端演示数据中的 `task-1` 等字符串不能直接调用真实接口。
- 成功：`{"data": ..., "meta": {"request_id": "..."}}`。错误：`{"error": {"code": "...", "message": "...", "details": ...}, "meta": ...}`。
- 请求与响应通过 `X-Request-Id` 关联；受保护的成功及错误响应设置 `Cache-Control: private, no-store`。
- 写请求必须携带 `Idempotency-Key`：1–128 个字符，不得为空、全空白或包含首尾空白。
- 更新证据和保存说明必须携带非负整数 `expected_version`。新证据初始 `lock_version=0`；说明第一次保存使用 `expected_version=0`，成功后为 1。
- Pydantic 输入使用额外字段拒绝策略；标题、原因等字符串会去掉首尾空白后校验。采纳、撤回、来源复查的 `reason` 必填，长度 1–4000。
- OpenAPI 提供 `EvidenceDTO`、`EvidenceDetailDTO`、`EvidencePageDTO`、`TaskNoteDTO` 等明确响应类型；前端应从 OpenAPI 生成类型。

## 2. 接口清单

下表路径均相对于 `/api/v1`。

| 方法与路径 | 用途与输入 | 返回 |
|---|---|---|
| `GET /projects/{project_id}/evidence` | 证据列表；支持 `task_id`、`author_id`、`criterion_id`、`source_type`、`status`、`q`、`page`、`page_size` | `EvidencePageDTO` |
| `GET /projects/{project_id}/evidence/effective` | B/D 有效证据查询；支持 `task_id`、`page`、`page_size` | 仅 `formal` 且 `source_changed=false` 的证据 |
| `GET /projects/{project_id}/evidence/{evidence_id}` | 证据详情、原始及后续来源快照、全部决策记录 | `EvidenceDetailDTO` |
| `POST /projects/{project_id}/evidence` | 新建候选；`task_id`、`title`、`description`、`source_type`、至少一个 `criterion_ids`；非手工来源另需 `source_id` | 201，`EvidenceDTO` |
| `POST /projects/{project_id}/evidence/{evidence_id}/adopt` | `expected_version`、`reason` | 更新后的 `EvidenceDTO` |
| `POST /projects/{project_id}/evidence/{evidence_id}/withdraw` | `expected_version`、`reason` | 更新后的 `EvidenceDTO` |
| `POST /projects/{project_id}/evidence/{evidence_id}/check-source` | `expected_version`、`reason`、原始 `source_id`；服务端经可信适配器复查 | 更新后的 `EvidenceDTO` |
| `GET /projects/{project_id}/tasks/{task_id}/note` | 默认当前说明版本；`history=true` 返回全部版本 | `TaskNoteDTO`；尚未创建时 `data=null` |
| `PUT /projects/{project_id}/tasks/{task_id}/note` | `expected_version`、`title`、`body` | `TaskNoteDTO`，包含此次保存的新版本 |

列表采用 `items/page/page_size/total`，`page` 从 1 开始，`page_size` 默认 50、最大 100。普通证据列表暂保留已标记废弃的 `offset/limit` 参数及同名返回字段；新调用方使用 `page/page_size`。筛选先于分页执行，关键词查询匹配标题和描述，长度最多 200。

候选标题最多 240 字符，说明最多 30000 字符；任务说明正文最多 100000 字符。验收标准列表最多 100 项且不能重复；每项必须属于该证据的同一个任务。任务和证据必须归属路径指定的项目，跨项目 ID 不会被自动重新关联。

## 3. 权限与可写前提

权限从数据库中的当前用户、项目成员、小组、课程及课程人员关系计算，复用 `app/modules/c/permissions.py`。

| 操作 | 允许主体 | 额外前提 |
|---|---|---|
| 读取证据和说明 | 本项目活跃学生成员、所属课程教师或活跃助教 | 账号为 active；同课程其他组仅凭课程关系不能读取项目内容 |
| 新建候选、保存说明 | 本项目活跃学生成员或所属教师 | 已验证邮箱；项目 active；所属课程 active；项目基线 frozen；最新计划 frozen 且快照包含任务；任务为 `in_progress` 或 `pending_submission` |
| 采纳、撤回、复查来源 | 证据作者、本项目组长或所属教师 | 仍须具备项目可写资格、邮箱已验证、项目/课程可写、项目基线 frozen |

所属教师为课程 owner，或拥有该课程活跃 `course_staff.teacher` 关系的教师；其他课程教师没有权限。项目组长仍须是本项目活跃成员；有小组时以关联小组的组长归属为准。普通成员不能采纳他人的证据，助教默认只读，平台管理员身份不自动授予项目内容权限。

采纳和撤回不会因为任务后来变为 `completed` 就自动开放给其他人，也不会重新应用“只能执行中提交新材料”的限制；其自身仍执行项目可写、证据状态、权限和版本校验。归档、定稿或课程结束后的写请求被拒绝。

## 4. 证据状态与历史

当前命令路径为：

```text
提交材料 -> candidate -> adopt -> formal -> withdraw -> withdrawn
                 └──────── withdraw ────────────────┘
```

- 新建只能产生 `candidate`，不能在请求体直接声明 `formal`。
- 采纳允许 `candidate` 或 `pending_confirmation`，且来源未发生变化；再次核验验收标准属于同一任务。
- 撤回允许 `candidate`、`pending_confirmation`、`formal`，保留证据、标准关联、原始快照和历次决策。
- `pending_confirmation`、`void` 属于兼容状态枚举；本批接口未提供进入这些状态的命令，也不提供证据硬删除、撤回恢复或原地改写正式证据的接口。
- 来源变化保持既有状态值，例如仍是 `formal`，同时设 `source_changed=true`、递增锁版本、追加来源快照和 `source_changed` 决策。
- `effective` 的定义是 `status == formal && !source_changed`。普通列表中的 `formal` 不等于仍可用于当前验收或贡献计算。
- 已变更来源的候选不能直接采纳。使用新的可信来源或最新任务说明版本提交新候选，旧记录继续保留。

## 5. 来源与快照

`source_type` 支持 `manual`、`task_note`、`discussion`、`file`、`screenshot`、`github`、`feishu`。

| 来源 | 来源身份与真实性边界 |
|---|---|
| `manual` | 保存用户提交的标题、正文及可选 HTTP(S) `source_url`，快照明确标记为用户手工内容；不声称已抓取或验证 URL 内容，不接受 `source_id` |
| `task_note` | `source_id` 是本任务当前 `TaskNoteVersion.id`；服务端读取数据库原文。旧版本不能作为“当前说明”提交新候选 |
| `discussion` | `source_id` 是同项目的重要、开放讨论 ID；服务端读取不可变讨论快照，包含当时的回复。新增回复或取消重要标记会使关联证据来源变化，原快照保留 |
| `file` / `screenshot` | `source_id` 交给 A 文件适配器验证；当前未接入，明确 503 |
| `github` / `feishu` | `source_id` 交给可信外部来源适配器验证连接、事件和项目归属；当前未接入，明确 503 |

非手工来源的 URL 必须由适配器返回，请求不得自行提供 `source_url`。手工 URL 只接受 HTTP(S)，不能包含用户名或密码。用户提交的标题、散列值、外部 URL 或“已删除”字段均不能证明外部来源的真实状态。

可信适配器契约位于 `source_ports.py`：

```python
SourcePort.resolve(
    project_id=project_id,
    actor_id=actor_id,
    source_type=source_type,
    source_id=source_id,
) -> VerifiedSource
```

`VerifiedSource` 包含项目、类型、稳定 `identity`、可信 `revision`、可复现 `content`、可选 URL/来源引用，以及 `availability`。C 继续核验项目和类型；若有 `source_reference_id`，还会核验引用属于本项目。

经上游确认的删除返回 `availability="deleted"`、相同来源 identity 与可信删除 revision。C 追加删除快照并使原证据失效；不会把旧快照改成空内容。网络故障、权限不足、暂时不可达应返回明确失败，不能冒充删除。新候选拒绝使用已经删除的来源。

每份证据的快照版本从 1 开始；第 1 版一直保留原始采集内容。后续内容或 revision 发生变化时新增快照，同时记录来源状态和 SHA-256 内容散列。来源 identity 不允许被替换。相同 revision、相同内容和相同 availability 的复查不制造新快照或事件。

详情响应的 `source_snapshots[].content` 是 `{source_id, availability, source}` 包装结构，原文位于 `content.source`，不是直接位于 `content.title/body`。真实证据页按此结构展示手工正文、任务说明版本和讨论正文/当时的回复；仅投影可读字段，不展示原始 UUID 或整份提供方元数据。来源变化后的快照单独展示，不替换第 1 版。

`check-source` 只接受原始 source ID、期望锁版本和原因，真正的变化事实来自可信适配器。它不支持手工内容或任务说明；任务说明由保存命令在同一数据库事务中处理。

## 6. 任务说明版本

`task_notes.task_id` 唯一，一个任务只有一个说明主记录。每次合法保存均新增 `task_note_versions` 行，递增 `current_version_no` 与 `lock_version`；相同幂等请求的网络重试不产生新版本。

`GET note` 只返回当前版本，`history=true` 按版本号倒序返回历史。每版包含编辑者、服务器时间、标题、正文和内容散列。客户端应保留读取到的 `lock_version`，冲突后先刷新并核对，而不是自动覆盖他人的新版本。

某个说明版本已转为证据后，再次保存说明会找到引用该任务说明的活跃候选/正式证据，逐条追加来源变化快照、决策和 outbox 事件。原说明版本、原证据快照与正式证据历史均保留。

真实任务页的说明历史与候选来源选择共用按当前账号、项目、任务隔离的 `taskNoteQuery`（`history=true`）。来源下拉只允许 `version_no == current_version_no` 的版本；保存说明或提交准备后统一刷新服务端结果。刷新确认旧来源失效时清空来源选择，保留候选标题、说明和验收标准。候选提交遇到 409 可“刷新并核对来源”，重新选择实际当前版本后再保存，不自动改用新版本提交。

## 7. 乐观锁、幂等与事务 outbox

写入先获取项目级数据库行锁，并读取真实归属与可写条件。可变行更新采用 `WHERE id = ... AND lock_version = expected_version`，更新数不为 1 时返回 409；这同时保护证据版本和说明单例的并发首存。

`c_request_idempotency` 的唯一域为 `(actor_id, project_id, operation, idempotency_key)`。它保存请求内容散列和首次成功的 `data`：

- 同域、同 key、同请求内容返回原结果，不重复创建、追加历史或生成事件。
- 同 key 配不同请求内容返回 `IDEMPOTENCY_CONFLICT`。
- 重试仍校验当前身份与项目权限，不允许借旧 key 绕过已失去的访问资格。
- 幂等行、业务变更、历史快照、决策与 outbox 在一个事务里提交；失败整体回滚。
- 领域服务不自行提交；HTTP 层 `commit_command` 统一提交/回滚。内部调用方同样必须负责事务边界。

真实 C2/C3/C6 页面在写请求确认成功后重置该次命令的幂等 key，再刷新读取结果；后续主动发送相同内容属于新的操作，使用新 key。响应失败或结果尚未确认时，相同输入重试保留原 key，避免已提交但未收到回执的写入重复落库。后续 GET 刷新失败不撤销已经确认的写入成功。

持久化 outbox 事件包括：

| `event_type` | 含义 |
|---|---|
| `evidence.candidate_created` | 候选与原始快照已写入 |
| `evidence.adopted` | 人工采纳为正式证据 |
| `evidence.withdrawn` | 证据已撤回，应重新评估下游使用 |
| `evidence.source_changed` | 来源变更或删除，原快照仍保留，应使关联评估过期 |
| `task_note.version_saved` | 任务说明已新增版本 |

outbox 保存 `id`、`project_id`、`aggregate_id`、事件类型、JSON payload、创建时间和可空 `delivered_at`。当前仅保证与业务事务一起持久化，尚未实现投递 worker、消息队列发布、消费确认或自动写入 B/D 状态。

后续投递器应按 outbox `id` 支持重试，消费者按事件 ID 去重；成功处理后再确认送达。不能在业务事务提交前直接通知 B/D，也不能将“outbox 已存在”呈现为“验收或贡献已更新”。

## 8. 调用示例

以下 UUID 仅演示请求格式，必须替换为同项目的真实数据库 ID；请求需要 A 接入后的实际认证上下文。示例没有添加绕过生产认证的临时身份头。

新建手工候选：

```http
POST /api/v1/projects/11111111-1111-4111-8111-111111111111/evidence
Content-Type: application/json
Idempotency-Key: evidence-submit-20261011-001

{
  "task_id": "22222222-2222-4222-8222-222222222222",
  "title": "任务接口实现记录",
  "description": "列明实现内容、验证步骤和结果。",
  "source_type": "manual",
  "criterion_ids": ["33333333-3333-4333-8333-333333333333"]
}
```

采纳与撤回使用同样的 body 结构，但应为每个独立操作生成不同的幂等 key，并使用刚读取到的真实版本：

```http
POST /api/v1/projects/11111111-1111-4111-8111-111111111111/evidence/44444444-4444-4444-8444-444444444444/adopt
Content-Type: application/json
Idempotency-Key: evidence-adopt-20261011-001

{"expected_version": 0, "reason": "已核对实现记录与该任务验收标准。"}
```

首次保存说明：

```http
PUT /api/v1/projects/11111111-1111-4111-8111-111111111111/tasks/22222222-2222-4222-8222-222222222222/note
Content-Type: application/json
Idempotency-Key: task-note-save-20261011-001

{"expected_version": 0, "title": "实现说明", "body": "本次完成内容与复现步骤。"}
```

返回的 `data.versions[0].id` 可作为新候选的 `source_id`，同时指定 `source_type="task_note"`、任务 ID 和验收标准 ID。后续保存应使用返回的 `data.lock_version`。

列表与有效证据查询：

```http
GET /api/v1/projects/11111111-1111-4111-8111-111111111111/evidence?status=formal&source_type=manual&q=接口&page=1&page_size=20
GET /api/v1/projects/11111111-1111-4111-8111-111111111111/evidence/effective?task_id=22222222-2222-4222-8222-222222222222&page=1&page_size=20
```

## 9. 与 A、B、D 的接入责任

| 对接方 | 当前接口边界 | 接入时必须落实 |
|---|---|---|
| A 身份 | canonical `get_current_user` 和共享 User/项目/课程关系 | 替换临时身份实现为真实已验证会话；保留账号状态、邮箱验证、当前关系和生产拒绝临时身份头的规则 |
| A 文件 | `SourcePort` 的 `file/screenshot` 分支 | 授权读取真实已完成的文件版本、核验项目归属和文件可用性、返回稳定版本与快照；对接真实对象存储，不能仅凭浏览器 object key 或 URL 放行 |
| B 任务与标准 | 读取 `tasks`、`acceptance_criteria`、最新 `plan_versions` | 使用一致的 UUID；确认计划快照含任务；保持任务/标准归属；更改验收标准时通知 D 使旧验收失效 |
| D 验收、贡献与报告 | `/evidence/effective` 与 outbox | 只使用有效正式证据；按事件 ID 幂等处理采纳/撤回/来源变化，使受影响验收过期并保留历史；报告引用可追溯证据 ID 和原快照，不能把候选数量直接当贡献 |
| GitHub / 飞书适配 | `SourcePort` 的可信来源分支 | 认证连接、验证同步事件和资源归属、保存可信版本、区分真实删除与临时失败；当前路由不实现连接授权或同步抓取 |

内部 B/D 调用不能通过制造普通用户或传任意 actor ID 获得权限。服务间认证方案尚未定义时，应使用现有真实授权上下文或经过明确装配的内部服务调用，并保持相同项目边界。

## 10. 数据库与代码位置

新增静态迁移 `services/api/migrations/versions/0007_c_evidence_notes.py`，前置为 `0006`；没有修改历史迁移。它创建八张表：

| 表 | 职责 |
|---|---|
| `evidence` | ERD 证据实体及当前状态、来源变更标记、锁版本 |
| `evidence_criteria` | ERD 证据与任务验收标准关联，组合主键防重复 |
| `evidence_decisions` | ERD 决策历史，原因非空 |
| `evidence_source_snapshots` | 新增：原始及后续来源快照，每证据版本号唯一 |
| `task_notes` | 新增：任务说明单例和当前版本指针 |
| `task_note_versions` | 新增：不可变说明版本，每说明版本号唯一 |
| `c_request_idempotency` | 新增：命令去重和原成功结果 |
| `c_integration_outbox` | 新增：与业务同事务的待投递事件 |

该迁移不创建 `files/file_versions`、GitHub/飞书连接或同步事件表，也不声称完成 ERD 中整个计划迁移 007/008 的全部内容。外部文件版本的关联等待 A 实际契约接入，不生成假的存储记录。

实现目录为 `services/api/app/modules/c/`：`evidence_*`、`note_*`、`models.py`、`integration_events.py`、`source_ports.py`；路由由 `router.py` 装配，数据模型需要纳入 canonical metadata。共享权限规则在 `permissions.py`。

## 11. 验证与生产限制

本次已实际运行的 52 条证据/说明服务及 HTTP 测试通过，覆盖权限矩阵、未验证邮箱、生产拒绝 demo 身份头、真实 SQLAlchemy 关系操作、版本冲突、幂等、事务回滚、来源变化/删除、说明历史、响应 DTO 与缓存头。该次运行使用测试专用 SQLite 关系结构，不等同于 PostgreSQL 迁移、JSONB 或行锁验证。Ruff 检查以及 0006→0007 的 PostgreSQL 离线 SQL 生成通过。

PostgreSQL 验证由独立验证任务运行，结果由集成交付记录统一维护；此处提供复核命令，不用上述 SQLite 测试结果替代 PG 验证。`C_TEST_DATABASE_URL` 应指向可写、已迁移的独立测试 PostgreSQL 数据库，不能指向生产库。PG 专用并发测试会创建并清理 UUID 命名的临时 schema，需要对应建 schema 权限；它验证竞争写入，不代替 Alembic 迁移测试。

在 `services/api` 目录执行（PowerShell）：

```powershell
# 先在专用测试环境配置 DATABASE_URL 和 C_TEST_DATABASE_URL。
.venv/Scripts/python.exe -m alembic upgrade head
.venv/Scripts/python.exe -m pytest tests/test_c_evidence.py tests/test_c_evidence_http.py tests/test_c_notes.py -q
.venv/Scripts/python.exe -m pytest tests/test_c_evidence_postgres.py -q
.venv/Scripts/ruff.exe check app/modules/c tests/test_c_evidence.py tests/test_c_evidence_http.py tests/test_c_evidence_postgres.py tests/test_c_notes.py
```

未设置 `C_TEST_DATABASE_URL` 时，关系/HTTP 测试使用测试专用 SQLite，三条 PG 并发测试明确跳过。PG 并发用例检查同 key 并发新建只产生一份证据和事件、同版本并发采纳只有一个成功、并发首次保存说明只产生一个单例和版本。

生产限制必须随交付保留：A 真实会话尚未接入时生产接口默认拒绝未认证请求；文件、GitHub、飞书真实适配器未接入时明确 503；outbox 尚未投递；没有自动完成 D 的验收更新或贡献重算。前端原有 Mock 运行结果也不能替代这些真实服务的联调验收。
