# C7 课程生命周期、审计用量与访问审批

## 范围与边界

本轮在 `services/api/app/modules/c/governance_*.py` 实现 C7-04、C7-07 的 canonical 命令与持久化，并为 C7-05、C7-06 提供 A 服务的只读 typed ports。前端 `GovernanceApiPages` 在 `governance=real` 时只使用真实 API；课程、日志、AI 用量、访问审批分别对应 C53–C56。没有服务器数据时不合并本地种子，也不把 503 当作零数据或写入成功。

所有管理接口重新查询当前 canonical User，要求 active Admin；写入另要求 A 当前学校邮箱绑定有效，并锁定当前操作人行。申请人接口使用当前身份，没有自由 applicant 参数。浏览器展示不代替服务端授权。PR #14 已交付 `services/api/app/auth` 的统一 Cookie/UUID 身份；浏览器 fixtures 仍不等于真实环境联调验收。

## 12 个接口

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
| GET /admin/ai-usage | Admin；days=7/30/90、user_id、feature、model |

## 课程与邀请码

复用 canonical Course，不修改 B 快照或 core 约束。现有数据库只保证 `(code, semester)` 唯一；C 创建命令先按 trim/lower 检查全部已有课程，再写 C-owned `c_course_code_registry` 唯一 code_key。并发的 C 写入只能有一个成功。历史重复编号拒绝操作但不重写；其他 writer 不经过 registry 时不受全局数据库唯一保证，必须在接入时使用此命令或协调升级约束。

草稿创建记录第 0 版历史。发布只允许 draft，要求当前有效且邮箱已验证的教师、未来项目截止时间、合理组队人数和截止顺序。发布同事务生成 192 位安全随机、唯一的 C-owned CourseInvite，并将课程改为 active；结束只允许 active，变为 ended 并撤销邀请码。变更用版本 CAS，状态、邀请、历史、幂等结果和 outbox 一起提交；失败全部回滚。

邀请码仅出现在 Admin 详情，不在列表、事件或历史中公开。给 B 的内部消费契约是 `governance_course_service.resolve_course_invite(session, code)`：返回有效 active 课程 ID，并共享锁定课程行；调用方须在同一事务中完成成员写入。该 service 本身不加成员，不改 B 加入流程；B 接入前不宣称加入链路已验收。

## 访问审批与 A 授权端口

`AccessScope` 只允许 read、project/task/evidence，明确 project_id/resource_id；project 类型两 ID 必须相同，task/evidence 必须真实属于该项目。创建申请先调用 trusted `AuthorizationPort.visible_target`，验明申请人和完整 scope 后才查询目标，避免向任意申请人暴露猜测 ID 是否存在。默认 503 `ACCESS_VISIBILITY_UNAVAILABLE`，不伪造可见性。

批准前复核申请状态/版本、申请人 active/邮箱、可见目标与未来时限，批准截止不得超过原申请。不可修改原范围，不可自批。`AuthorizationPort.activate` 必须在传入的同一 SQLAlchemy Session/事务中激活授权；回执必须严格匹配 request、applicant、scope、expiry，并有 UUID grant_id。默认 503 `ACCESS_AUTHORIZATION_UNAVAILABLE`。无有效回执就不写 approved，CAS/约束失败也回滚 A 的同事务写入。

远端 A 服务不能靠返回任意字符串就满足同事务协议；若实际部署为跨库/远程授权，必须另行设计可靠协调，再接入本端口。fixture 中的 grant outbox 只证明事务回滚，不构成生产授权实现。

同 key 同内容重试首先检查当前操作者权限并校验原内容指纹，随后返回当前实体详情，不重复授权；相同 key 不同内容 409。课程已结束或访问期限已过时，重试不会返回旧的 active/未到期状态。Admin 决定只允许 pending 转 approved/rejected；拒绝不调用激活服务。outbox 仅持久化事实，不声称通知已送达。`authorization_state=receipt_recorded_current_access_not_checked` 表示曾收到激活回执，不表示现在仍有权限；当前授权的撤销/到期检查仍由 A 执行。详情与幂等重试均实时计算 `approval_expired`。

## A 审计与 AI 用量只读协议

`GovernanceReadPort` 默认为 503，禁止用 C 本地历史假装完整 A 审计。审计页要求过滤后的精确 total、完整指定页、时间降序和 ID 稳定排序、无重复且符合全部条件；actor_role 是事件发生时的角色（含历史组长或系统），不能用当前角色猜测。角色、对象类型和对象 ID 过滤一并前推 provider，返回不匹配记录会拒绝。详情 ID 必须精确匹配。before/after 只接受明示白名单的标量元数据，禁止任意正文、密钥或嵌套对象；A 适配器仍有责任脱敏 reason/action，不可把敏感正文塞入描述字段。

用量端口返回真实 UsageSample，时间必须带时区，成功标志和 token 数严格类型，费用非负 Decimal 并有 USD/CNY 币种。7/30/90 天表示从 UTC 日历起点到当前时刻（不含末端）的窗口，筛选前推 A；每页 200，snapshot_id/total 必须跨页稳定、页完整、无重复、全部样本符合筛选。最多 10000 样本，超限拒绝部分汇总并要求收窄查询或接 A 聚合服务。

按 UTC 日期、功能、模型分别聚合真实请求数、成功/失败、token 和费用；币种不混加。真实完整空窗口才显示零计数。没有 A 数据时 503，不给虚构健康率、趋势、费用或来源状态。日志/用量页的操作人选择读取 canonical Admin 用户目录，URL 保存筛选；对象 ID 来自已有日志的「筛选此对象」按钮或 URL 上下文，没有自由 UUID 输入框。

## 前端行为与验证

课程创建从 canonical Admin 用户目录搜索、分页选择已验证的有效教师；没有合格选项就不能提交。课程和审批详情显示真实范围、版本与历史，原因必填，重复点击同步拦截，相同请求失败重试沿用幂等键。版本冲突保留理由，刷新详情核对后才能重试。审批服务缺失保留 pending，不乐观显示 approved。所有列表刷新失败时隐藏旧结果；缓存按当前工作区身份分区，生产安全仍由服务器会话和权限保证。

迁移 `0012` 父为 `0011`；只新增 C 表。非空治理表拒绝降级，避免误删历史/授权记录；空表降级可回到 `0011` 并再次升级。未修改 canonical code+semester 约束。

最终本地验证（2026-10-12）：治理 74 项服务/HTTP 测试与 7 项隔离 PostgreSQL 并发/迁移测试均已纳入主任务的 canonical 全套 **813 passed、零 skipped** 结果；该全套数量包含 SQLite/HTTP 测试，不能称作 813 项 PostgreSQL 测试。测试文件为 `test_c_governance.py`、`test_c_governance_http.py`、`test_c_governance_reads.py`、`test_c_governance_postgres.py`。

治理浏览器回归 `e2e/c-governance-api.spec.ts` **11/11 通过**，包括相同请求保留幂等键重试、权限失效清除旧详情、版本冲突保留理由、刷新保留创建草稿、完整日志筛选和服务不可用状态。它使用显式拦截 fixture 验证真实 API 页面分支，不等于 A 生产接入验收。前端 TypeScript、目标 ESLint 和本批生产构建均已通过；构建包含编译、类型检查、静态生成和 trace 收集。远端 CI、PR 审查和团队验收尚待完成，不在此标记通过。后续结果由总交付记录统一更新。
