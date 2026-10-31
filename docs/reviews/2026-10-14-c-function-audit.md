# C 功能完整性复核（2026-10-14）

依据：飞书 C1–C7 的 35 个任务编号、当前源码、已有测试及最小复现。
审计版本：`develop` / `414399131c1b112d6cf45556e3e39cdd8e1062cb`。

## 后续修复状态（同日）

下文保留修复前的复现和行号，避免把原审计误当作当前代码状态。本轮已修复四项
集成阻断，以及任务描述、作者/提及选择、回复与个人动态定位、真实导航/通知角标；
增加了授权来源检查入口。测试另发现并修复日志/用量页切换筛选时清空输入的问题。
实际验证和提交信息见 [C 交付记录](../C_DELIVERY.md)。

仍未完成：全局搜索提供方、自动来源变化事件与可靠投递、外部存储/来源/通知/
审计/用量/访问授权提供方、B 稳定任务编号和 D 验收联动。来源检查入口不会替代
这些提供方；关闭假数据时也不会伪造搜索结果或通知数字。

## 原始审计

PR #12 已于 2026-10-12 合并；PR #14 随后合并了统一认证和 UUID 用户模型。
最新 develop 的 [CI](https://github.com/ZZJ1977/groupproof/actions/runs/38251210524) 通过。
因此，旧交接记录中“生产身份桥接完全未实现”的描述已经过时；这次发现的是
新认证与既有 C 功能之间仍存在不一致，而不是完全没有真实认证代码。

本次为源码与函数/内存数据库复核，没有修改业务实现，没有重新执行全量浏览器、
PostgreSQL 或线上验收。以下复现均使用隔离数据，无第三方账号或生产数据写入。

## 1. 优先修复的集成阻断

| 优先级 / 任务 | 未完善行为及实际影响 | 证据 / 修复方向 |
| --- | --- | --- |
| P1 · C2/C3/C4/C5/C6/C7 写操作 | 走新的同源 `/api/v1` 代理时，浏览器传入的 `Idempotency-Key` 被丢弃；要求该请求头的保存说明、证据、关联、讨论、文件和治理命令会校验失败。开始任务等不要求该头的接口不在此结论内。 | [代理白名单](../../app/api/v1/[...path]/route.ts#L16) / [C 必填头](../../services/api/app/modules/c/evidence_router.py#L59)。实际代理函数复现：`incomingIdempotency=true, forwardedIdempotency=false, forwardedCsrf=true`。补充代理契约及真正穿过代理的回归，需与 A 协调共享文件。 |
| P1 · C2/C3/C5/C6/C7 权限 | 新学校邮箱验证写 `SchoolEmailBinding.verified_at`，C 的业务写权限仍检查 `users.email_verified_at`。真实用户可以完成注册并登录，却继续被 C 判为未验证，相关写按钮/命令和教师选择受影响。 | [认证写点](../../services/api/app/auth/services/email_challenges.py#L198)、[C 校验](../../services/api/app/modules/c/permissions.py#L178)、[治理校验](../../services/api/app/modules/c/governance_common.py#L29)。隔离复现：`binding_verified=True, canonical_verified=None`，随后实际治理权限函数返回 `403 EMAIL_NOT_VERIFIED`。与 A 统一权威验证事实，并覆盖撤销/更换邮箱；不能只放宽权限。 |
| P2 · C7-01 状态筛选 | 选择“启用”或“停用”后，目录查询都会返回空结果，即便存在对应账号。 | [查询](../../services/api/app/auth/routers/c_admin.py#L76) 对普通 Python `@property` `User.account_status` 作 SQL 比较；真实模型编译两种条件均为 `WHERE false`。应查询实际 `User.status`，保持 enabled 对 active/pending 的映射语义。C 可独立修复此查询。 |
| P2 · C7-02 停用新账号 | 统一用户模型的初始版本为 0，目录能返回 version 0，但停用请求模型要求 `expectedVersion >= 1`，这些账号无法停用，返回 422。不是所有账号都会触发，资料编辑后升版会掩盖问题。 | [请求校验](../../services/api/app/auth/routers/c_admin.py#L27)、[版本默认值](../../services/api/app/db/models/core.py#L41)。实际模型校验：0 被拒，1 被接受。统一版本范围，同时保留服务端并发版本校验。 |

这些问题没有被已有绿色 CI 排除：C 的浏览器测试主要拦截 API 响应，不能验证实际
Next 代理；新认证流程测试验证了注册和 `/whoami`，没有继续完成 C 的真实写入链路。

## 2. C 仍可独立推进的功能和交互

| 任务 / 优先级 | 缺口 | 证据与建议 |
| --- | --- | --- |
| C1 及跨页面入口 · P1 | 真实模式的公共工作区读取仍恒定报 501，随后回退到演示种子。真实 UUID 项目的侧栏无法识别项目；全局搜索、教师默认课程和通知红点仍使用演示数据。 | [真实服务](../../lib/api/real-service.ts#L23)、[回退](../../lib/workspace.tsx#L56)、[导航](../../components/workspace-shell.tsx#L47)、[红点](../../components/workspace-shell.tsx#L130)。函数实测真实 UUID 的导航 context 为 `{}`、项目侧栏关闭，种子未读为 2、默认课程为 `course-1`。可先消除真实模式种子回退、把红点接到真实通知状态；公共导航与真实课程/项目入口须与 A/B 协调。 |
| C2-02 · P2 | 真实任务详情未展示 B 已保存的任务描述。 | [Task.description](../../services/api/app/db/models/core.py#L644) 已存在，但 [选择器 DTO](../../services/api/app/modules/c/context_router.py#L36) 不返回， [执行概览](../../features/c/ExecutionApiPage.tsx#L99) 不显示。可以只补读取和展示，不修改 B 的任务数据。 |
| C3-01 / C4-01/03 / C6-02 · P2 | 证据/活动作者筛选及讨论 @ 人员共用“当前活跃学生成员”列表，漏掉合法历史作者、教师和 TA。 | [成员投影](../../services/api/app/modules/c/context_router.py#L110)、[证据筛选](../../features/c/EvidenceApiPage.tsx#L99)、[活动筛选](../../features/c/ActivityApiPages.tsx#L116)、[提及](../../features/c/DiscussionsApiPage.tsx#L18)。内存关系查询证实教师/退组作者的证据存在，但没有选项；后端允许提及本课程教师/TA，前端不可选。应分别提供授权历史作者与当前可提及对象，保留 URL 中合法的已选作者。 |
| C6-02 · P2 | 讨论超过一页时，回复成功只刷新原页，用户看不到刚发的回复。 | [回复查询](../../features/c/DiscussionsApiPage.tsx#L33)、[保存操作](../../features/c/DiscussionsApiPage.tsx#L71)。内存创建 11 条递增时间回复：第 1 页仍为 1–10，新回复在第 2 页。利用成功回执提供定位或切到新回复所在页，补多页回归。 |
| C1-04 · P2 | 个人动态中的证据事件只跳到任务证据列表，说明/进度事件跳任务概览，没有直接定位对应证据或历史记录；目标不在第一页时还需逐页寻找。 | [动态链接构造](../../services/api/app/modules/c/daily_service.py#L403)。证据详情已有 `?evidence=<id>`，可以直接利用；说明/进度应进入相应历史区域并支持定位。此项按链接和页面代码核对，未运行浏览器。 |
| C3-04/05 与 C4 联动 · P2 | 活动页已发现来源变化，并不等于对应证据已经失效；前端也没有“核查证据来源”入口。 | [活动读标记](../../services/api/app/modules/c/activity_service.py#L213)、[实际核查命令](../../services/api/app/modules/c/evidence_service.py#L520)、[页面提示](../../features/c/ActivityApiPages.tsx#L124)。内存复现活动 `source_changed=True` 时，关联正式证据仍 `source_changed=False,effective=True`。C 可补授权核查入口；生产来源事件和可靠失效流程仍需 A/D。不得把 GET 查询改成隐式写入，也不能仅凭追加一个不可变文件新版本就使旧版证据失效。 |
| 交接文档 · P2 | 多份 C 文档仍写“身份服务与 canonical UUID 不兼容”“PR #11 待审”，会误导后续联调。 | `C_REAL_PAGES.md`、`C_DELIVERY.md` 开头及 `C_REMAINING_WORK.md` 的当前依赖说明需按 PR #12/#14 的实际状态更新，同时保留历史记录。 |

## 3. 尚未完成的功能链路及明确依赖

| 功能 / 任务 | 当前有的部分 | 尚缺什么 / 谁配合 |
| --- | --- | --- |
| 通知、待办与首页计数（C1-01–03） | 页面、接收人/分页/快照校验、已读命令及首页计数契约 | [InboxPort](../../services/api/app/modules/c/inbox_ports.py#L96) 默认仍 unavailable；需要 A 的真实通知/待办提供方、已读持久化服务及投递。数据源不可用时应保持不可用，不能伪造 0。 |
| GitHub / 飞书（C2-06/07、C4） | 活动列表、过滤、人工关联、采纳/忽略、候选证据等 C 逻辑 | [ActivitySourcePort](../../services/api/app/modules/c/activity_ports.py#L85) 默认 503；A 提供同步、连接状态、授权记录查询及可信 SourcePort。个人动态的 GitHub/飞书来源也未纳入。 |
| Commit 自动关联（C4-02） | 人工关联和基于标题的建议 | [现有规则](../../services/api/app/modules/c/activity_service.py#L142) 只是建议，`#T12` 不匹配而 `T-12` 才匹配；无自动落库消费者。需 B 确定独立稳定任务编号，C 再实现规则/幂等关联，不能猜 UUID 或列表顺序。 |
| 文件上传、新版本、课程替换（C5-02–04） | 文件元数据、不可变版本、正式指定/发布、下载链接契约 | [项目页](../../features/c/ProjectFilesApiPage.tsx#L103)、[课程页](../../features/c/CourseFilesApiPage.tsx#L124) 明确上传不可用；A 的项目/课程上传回执、实际字节、签名链接尚未接入。之后 C 仍需完成上传进度、重试和登记，B 需确认冻结版本引用。 |
| 提交→验收→完成（C2-01/02/08） | 开始、进度、实现说明、候选证据及原子提交准备 | [验收 Tab](../../features/c/ExecutionApiPage.tsx#L101) 和 D 的页面入口仍不可用；D 提供查询、完整性检查、权威完成/退回服务后，C 接上跳转和显示。不能用 100% 进度代替验收。 |
| 证据变化、贡献、报告和通知（C3/C5/C6） | C 的持久状态、正式有效证据查询及事务 outbox | A 的通知投递和来源事件、D 的验收失效/贡献/报告消费者未闭环。outbox 行不代表已送达。 |
| Admin 新增/恢复账号（C7-02） | 目录、停用、审核 | [当前页面](../../features/c/IdentityAdminApiPages.tsx#L83) 明确恢复/新增不可用；需与 A 定义新用户的初始凭据/邀请/验证及恢复后的会话规则，再完成 C UI/API。 |
| 系统日志、AI 用量（C7-05/06） | 查询/聚合契约及页面 | [默认读取端口](../../services/api/app/modules/c/governance_read_ports.py#L72) 仍 503，需 A 的真实记录适配，不能把认证审计表未经审查直接当作所有业务日志。 |
| 访问审批、课程生命周期（C7-04/07） | C 决定记录、原因、版本、期限和课程邀请码 | [授权端口](../../services/api/app/modules/c/governance_ports.py#L65) 仍不可用；A 必须在资源访问时实际执行范围/到期限制。B 还需消费邀请码及结束课程的业务约束。 |

## 4. 建议推进顺序

1. 先修同源代理头、学校验证事实、Admin 状态查询和 version 0 的兼容，补“真实 Cookie → Next 代理 → C 写入”的集成测试。
2. 修真实模式的演示数据回退和导航/红点一致性，随后补任务描述、参与者选择和新回复定位。这些不是等待第三方密钥才能开始的工作。
3. 与 A/B/D 对接上表的具体端口和规则，然后完成上传、自动关联、验收、通知及权限执行的真实闭环。
4. 关闭 mocks，用干净数据库、多用户和真实页面走完整验收。当前不据 CI 或任务编号覆盖率宣称“35 项全部完成”。

此次结果说明仍有明确可推进的 C 工作，也有真实协作依赖；应分别记录和验收，不能合并为一个缺乏依据的完成百分比。
