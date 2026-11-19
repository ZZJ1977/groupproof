# C7 课程生命周期、审计用量与访问审批

## 范围与边界

本轮在 `services/api/app/modules/c/governance_*.py` 实现 C7-04、C7-07 的 canonical 命令与持久化，并为 C7-05、C7-06 提供 A 服务的只读 typed ports。前端 `GovernanceApiPages` 在 `governance=real` 时只使用真实 API；课程、日志、AI 用量、访问审批分别对应 C53–C56。没有服务器数据时不合并本地种子，也不把 503 当作零数据或写入成功。

所有管理接口重新查询当前 canonical User，要求 active Admin；写入另要求 A 当前学校邮箱绑定有效，并锁定当前操作人行。申请人接口使用当前身份，没有自由 applicant 参数。浏览器展示不代替服务端授权。PR #14 已交付 `services/api/app/auth` 的统一 Cookie/UUID 身份；浏览器 fixtures 仍不等于真实环境联调验收。

## 14 个接口

共同前缀 `/api/v1`，命令必须提供 `Idempotency-Key`。分页默认 10、最多 100；用户目录固定每页 10。

| 方法与路径 | 权限与行为 |
| --- | --- |
| GET /admin/courses | Admin；q、semester、status、page/page_size |
| POST /admin/courses | Admin；创建课程草稿，验证负责教师，理由必填 |
| GET /admin/courses/{course_id} | Admin；设置、版本、历史、真实邀请码 |
| POST /admin/courses/{course_id}/transitions | Admin；publish/end，理由、expected_version |
| GET /me/access-requests | 当前用户自己的申请，status、分页 |
| POST /me/access-requests | 当前用户；结构化只读 scope、reason、expires_at |
| GET /admin/access-requests | Admin；status、分页 |
| GET /admin/access-requests/{request_id} | Admin；范围、时限、回执状态、历史 |
| POST /admin/access-requests/{request_id}/decisions | Admin；approved/rejected、reason、expected_version；批准需要 expires_at |
| GET /admin/audit-logs | Admin；actor_id、actor_role、target_type、target_id、action、result、since/until、分页 |
| GET /admin/audit-logs/{record_id} | Admin；脱敏元数据详情 |
| GET /admin/auth-audit-logs | Admin；A 已持久化的认证事件，操作、结果、用户、时间与分页 |
| GET /admin/auth-audit-logs/{record_id} | Admin；认证事件安全投影，不透明字符串 ID |
| GET /admin/ai-usage | Admin；days=7/30/90、user_id、feature、model |

## 课程与邀请码

复用 canonical Course，不修改 B 快照或 core 约束。现有数据库只保证 `(code, semester)` 唯一；C 创建命令先按 trim/lower 检查全部已有课程，再写 C-owned `c_course_code_registry` 唯一 code_key。并发的 C 写入只能有一个成功。历史重复编号拒绝操作但不重写；其他 writer 不经过 registry 时不受全局数据库唯一保证，必须在接入时使用此命令或协调升级约束。

草稿创建记录第 0 版历史。发布只允许 draft，要求当前有效且邮箱已验证的教师、未来项目截止时间、合理组队人数和截止顺序。发布同事务生成 192 位安全随机、唯一的 C-owned CourseInvite，并将课程改为 active；结束只允许 active，变为 ended 并撤销邀请码。变更用版本 CAS，状态、邀请、历史、幂等结果和 outbox 一起提交；失败全部回滚。

邀请码仅出现在 Admin 详情，不在列表、事件或历史中公开。给 B 的内部消费契约是 `governance_course_service.resolve_course_invite(session, code)`：返回有效 active 课程 ID，并共享锁定课程行；调用方须在同一事务中完成成员写入。该 service 本身不加成员，不改 B 加入流程；B 接入前不宣称加入链路已验收。

## 访问审批与 A 授权端口

访问申请支持项目、任务、证据三种只读范围。审批调用 A 的 `DatabaseAuthorizationPort.visible_target` 检查申请人是否可见项目，再由 C 核实资源归属。首页提供申请、本人记录和已批准资源的入口。

批准时复核申请版本、账号、邮箱、目标与截止时间。A 的 `activate` 在 C 的审批事务中保存授权。C 核对回执中的申请人、资源、期限和授权编号，通过后持久化审批结果。

C 的内容读取调用 A 的 `has_read_grant` 核对项目和具体资源。任务临时授权只显示本任务的内容，证据临时授权可打开该条证据及其历史快照。到期或撤销后，下次读取立即失效。写操作仍检查项目成员及相应业务角色。

同 key 同内容重试首先检查当前操作者权限并校验原内容指纹，随后返回当前实体详情，不重复授权；相同 key 不同内容 409。课程已结束或访问期限已过时，重试不会返回旧的 active/未到期状态。Admin 决定只允许 pending 转 approved/rejected；拒绝不调用激活服务。outbox 仅持久化事实，不声称通知已送达。`authorization_state=receipt_recorded_current_access_not_checked` 表示曾收到激活回执，不表示现在仍有权限；当前授权的撤销/到期检查仍由 A 执行。详情与幂等重试均实时计算 `approval_expired`。

## A 审计与 AI 用量只读协议

### 已接入的认证日志（C7-05，2026-10-15）

`/admin/logs?source=auth` 通过 C 的两个只读接口直接读取 A 已有的
`AuthAuditEvent`，无需新的外部服务或数据库迁移：

- `GET /api/v1/admin/auth-audit-logs`：按操作、结果、操作者、目标用户和时间筛选，服务器分页。
- `GET /api/v1/admin/auth-audit-logs/{record_id}`：读取原始认证事件的安全投影；ID 沿用 A 的不透明字符串。

响应明确标明 `source=auth_audit_events`、`scope=authentication`。认证日志与原全站业务日志分别查询；
认证记录可用不表示全站审计提供方已经接通。所有请求检查当前管理员身份；页面不提供修改或删除日志的操作。
显示事件时间、操作、结果和白名单内的变更字段名。A 未保存的历史角色、改前/改后值、处理原因不推断补齐，
请求原文、完整邮箱、会话和验证码也不从底层记录透传。未知元数据使用显式脱敏标记。
筛选和当前页写入网址，权限失效后清除旧列表与详情。验证记录见 `C_DELIVERY.md`。

### 全站业务日志和 AI 用量

共享服务操作日志直接查询 A4 的记录，可按操作、事件当时的角色、结果和对象筛选，详情显示经过筛选的改前、改后字段及原因。旧记录角色未知时按原值展示。全站业务审计仍使用独立的提供方。

用量端口从 A 的 `list_ai_usage` 读取时间窗口内的记录，核对来源页数、总数和重复 ID。C 按 7、30 或 90 个 UTC 自然日及用户、功能、模型筛选，分别累计各币种的已知费用，并显示缺费用或 token 的调用数。单次查询上限为 10,000 条。

按 UTC 日期、功能和模型汇总请求数、成功和失败数、已记录 token 和费用。来源出错时返回错误。管理员可从用户目录设置筛选，日志筛选可从 URL 恢复。

## 前端行为与验证

课程创建从 canonical Admin 用户目录搜索、分页选择已验证的有效教师；没有合格选项就不能提交。课程和审批详情显示真实范围、版本与历史，原因必填，重复点击同步拦截，相同请求失败重试沿用幂等键。版本冲突保留理由，刷新详情核对后才能重试。审批服务缺失保留 pending，不乐观显示 approved。所有列表刷新失败时隐藏旧结果；缓存按当前工作区身份分区，生产安全仍由服务器会话和权限保证。

迁移 `0012` 父为 `0011`；只新增 C 表。非空治理表拒绝降级，避免误删历史/授权记录；空表降级可回到 `0011` 并再次升级。未修改 canonical code+semester 约束。

最终本地验证（2026-10-12）：治理 74 项服务/HTTP 测试与 7 项隔离 PostgreSQL 并发/迁移测试均已纳入主任务的 canonical 全套 **813 passed、零 skipped** 结果；该全套数量包含 SQLite/HTTP 测试，不能称作 813 项 PostgreSQL 测试。测试文件为 `test_c_governance.py`、`test_c_governance_http.py`、`test_c_governance_reads.py`、`test_c_governance_postgres.py`。

治理浏览器回归 `e2e/c-governance-api.spec.ts` **11/11 通过**，包括相同请求保留幂等键重试、权限失效清除旧详情、版本冲突保留理由、刷新保留创建草稿、完整日志筛选和服务不可用状态。它使用显式拦截 fixture 验证真实 API 页面分支，不等于 A 生产接入验收。前端 TypeScript、目标 ESLint 和本批生产构建均已通过；构建包含编译、类型检查、静态生成和 trace 收集。远端 CI、PR 审查和团队验收尚待完成，不在此标记通过。后续结果由总交付记录统一更新。
