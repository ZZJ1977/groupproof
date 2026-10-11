# GroupProof 分阶段开发入口

更新日期：2026-10-06

本目录把已确认的成员 B 功能开发方案拆成可执行阶段。01–13 为前端功能与接口交付，14–15 为功能验收后的全项目设计规范。所有阶段当前均为待开发。

## 新 agent 的背景读取顺序

1. [项目根 AGENTS.md](../../AGENTS.md)：项目工作约定和用户已经确认的开发顺序。
2. [项目 README](../../README.md)：启动方式、技术环境、工程检查和 Mock 范围。
3. [PROJECT_CONTEXT.md](PROJECT_CONTEXT.md)：产品背景、领域对象、角色分工、最新决策及已知代码缺口。
4. [FRONTEND_STATUS.md](../../FRONTEND_STATUS.md)：已记录的实现状态、验证结果与真实服务接入限制。
5. [FRONTEND_IMPLEMENTATION_PLAN.md](../../FRONTEND_IMPLEMENTATION_PLAN.md)：原型结构和 56 页路由映射；其中历史实施顺序不替代本目录的最新阶段顺序。
6. 本文件的阶段表、指定阶段及其依赖文档，再阅读该阶段列出的源码。

这些文件相互补充。PROJECT_CONTEXT 和各阶段记录的是本次目标，FRONTEND_STATUS 中已有原型的“已完成”不能替代新阶段的验收。先核对当前 checkout 的文件和实际代码，确认前置阶段是否已经实现。

## 范围与已确认约定

- 成员 B 负责页面 07–10、23、29、35、38–40、46–47 的业务完善，并交付后端操作契约。
- 当前沿用 Next.js、React、TypeScript、现有组件、视觉风格和 URL；本轮交付仍是 Mock 前端与接口设计。
- 正式数据库、身份认证、对象存储、AI、GitHub 与飞书服务由后续接入实现。本目录不把模拟操作标记为真实集成。
- 用户明确要求先完成功能，再进行“专业教学管理台”视觉改版和动效。基本操作反馈、错误处理、键盘操作和必要响应式随功能一起完成。
- 全局设计阶段由 B 交付规范与参考；共享组件和其他成员的页面代码由对应开发者实现。
- 团队共同编辑并确认各自责任，组长推进发布。例外推进记录原因和未确认成员，硬性结构校验仍需通过。
- 同课程其他小组仅能读取“课程内可见”项目的公开总览；助教默认只读，由课程教师按操作授权。
- 保留稳定实体 ID、任务三视图共享数据、AI 验收仍需人工确认、100% 进度不自动提交、正式证据按现有规则撤回或作废。

## 阶段、依赖与执行顺序

| 阶段 | 内容 | 前置阶段 | 状态 |
|---|---|---|---|
| 01 | [权限矩阵与权限判断](01-权限矩阵与权限判断.md) | 项目背景 | 已完成 |
| 02 | [版本模型与成员确认](02-版本模型与成员确认.md) | 01 | 已完成 |
| 03 | [业务命令与持久化](03-业务命令与持久化.md) | 01、02 | 已完成 |
| 04 | [课程规则与模板](04-课程规则与模板.md) | 01–03 | 已完成 |
| 05 | [课程项目创建](05-课程项目创建.md) | 01–04 | 已完成 |
| 06 | [需求基线管理](06-需求基线管理.md) | 01–05 | 已完成 |
| 07 | [项目初始化流程](07-项目初始化流程.md) | 05、06 | 已完成 |
| 08 | [任务规划与发布](08-任务规划与发布.md) | 03、06、07 | 已完成 |
| 09 | [课程规则变更处理](09-课程规则变更处理.md) | 04、06、08 | 已完成 |
| 10 | [项目资料与文件版本](10-项目资料与文件版本.md) | 01–03、05 | 已完成 |
| 11 | [项目设置与生命周期](11-项目设置与生命周期.md) | 03、06、08、10 | 已完成 |
| 12 | [项目总览与统计](12-项目总览与统计.md) | 05–11 | 已完成 |
| 13 | [功能验收与后端接口交接](13-功能验收与后端接口交接.md) | 01–12 | 待验收 |
| 14 | [UI-UX-重新设计](14-UI-UX-重新设计.md) | 13 功能验收通过 | 待验收 |
| 15 | [动态交互与动效规范](15-动态交互与动效规范.md) | 14 视觉与组件结构稳定 | 待验收 |

这是代码实现依赖顺序。先完成基线服务，再由初始化第六步复用确认与发布接口；用户使用顺序仍是创建项目 → 初始化 → 基线确认 → 任务规划。

用户指定单一阶段时，实施该阶段以及明确授权的必要前置工作。用户要求连续功能开发时，按 01–13 的依赖推进；14–15 按功能验收后的设计任务范围执行。

## 阶段交付与状态记录

每阶段更新本表状态，并记录：变更文件、实际操作行为、验证命令及结果、数据迁移影响、未接入的外部服务和下一阶段接口。状态使用待开发、开发中、待验收、已完成、受阻；已完成必须有相应代码与验证证据。原型已经存在的部分按实际核对结果复用。

每完成一个阶段，另在 [stage-reports](stage-reports/) 目录存放一份简要总结（文件名 `阶段号-阶段名.md`），包含任务范围、完成内容、验证结果、剩余限制和下一阶段接口；详细证据仍记在本文件的阶段实施记录中。

权限、模型和命令层属于共享基础。其他成员调用这些对象时也应使用受控接口，完成联调后才能声称读写入口已统一。阶段 03 的命令样例不意味着全部旧调用已经迁移。

## 阶段实施记录

### 阶段 01：权限矩阵与权限判断（2026-10-06，待验收）

**实际变更**

- `types/domain.ts`：新增 `DelegatedPermission`、`AssistantGrant`、`ProjectSummary`；`Course.assistantGrants?`、`Project.ownerId?`。
- `lib/access/policy.ts`（新增）：只读纯函数 `can(data, actorId, action, target)` 及 `projectSummary` / `isCourseStaff` / `assistantGrantOf` 辅助；组长按目标 `Group.leaderId` 或无小组项目 `ownerId` 判断；不存在资源、未知操作、非 active 账号、跨课程引用默认拒绝；管理员不默认获得本范围权限。
- `mocks/seed.ts`：新增独立助教 `ta-1` 并归属 `course-1`（`assistantGrants`，默认只读）；`project-2` 明确 `ownerId: member-1`；四个项目补充 `visibility`（`project-1` 为 `course`，其余 `members`）。
- `lib/workspace.tsx`：演示角色 `ta` 切换到独立账号 `ta-1`（不再复用 teacher-1）。
- `features/project-core/core-model.ts`：`useProjectCore` 改用 `can()` 计算 `canView`（content.read）、`canSummary`（summary.read）、`canEdit`（draft.edit + active）、`canLead`（目标资源组长资格）；项目核心页的 `core.role === "leader"` 全部改为 `core.canLead`。
- `features/project-core/ProjectPublicSummary.tsx`（新增）：公开总览组件，仅展示 `ProjectSummary` DTO 字段（id/name/description/progress/lifecycle）；另有统一拒绝提示组件。
- `features/project-core/ProjectCoreView.tsx`、`features/project-support/ProjectSupportView.tsx`：项目页统一选择 summary.read / content.read；仅有公开总览资格时展示公开 DTO，两者皆无则拒绝。项目支持页（21–29）此前只判断项目存在，现补齐阅读门禁。
- `ProjectSupportView.tsx`（B 页 23/29）：文件上传/替换/设为正式走 `project.files.write`；项目设置/集成开关走 `project.settings.update`，归档走 `project.archive`；移除“无小组项目取 memberIds[0] 为负责人”的旧逻辑，命令执行前用最新数据复核资格。
- `features/course/CourseView.tsx`（B 页 35/38/39/40）：阅读走 `course.read`；创建项目 `project.create`（目标小组组长）、规则适用确认 `project.rules.apply`（目标项目组长）、重新开启 `project.reopen`；无资格时隐藏/禁用入口并展示说明。
- `features/governance/TeacherViews.tsx`（B 页 46/47）：页面入口走 `isCourseStaff`；课程设置 `course.settings.update`；规则模板编辑 `course.rules.edit` 与发布 `course.rules.publish` 分开判断；教学团队页展示助教归属与授权（只读）。
- `features/route-dispatcher.tsx`：布局选择与访问资格分离；项目/课程页（7–40）允许所属教学人员进入，具体阅读资格由页面内 `can()` 判断；个人页（04–06/30）、教师页（41–50）、平台治理（51–56）保持原专用规则。
- `scripts/check-access.mjs`（新增）与 `package.json`：`npm run check:access` 权限矩阵断言测试。
- 文档：新增[写入口迁移清单](01-写入口迁移清单.md)（阶段 03 输入）；同步 `FRONTEND_STATUS.md` 与 `PROJECT_CONTEXT.md` 的相关状态。

**验证命令与结果（2026-10-06，Node.js 22.22.3）**

- `npm run check:access`：53 项权限矩阵断言全部通过（覆盖阶段测试场景：member-5 发布 project-3、member-1 不能发布、跨课程教师拒读、member-21 仅公开总览、助教授权/撤销、disabled/pending、未知操作、无效目标、跨课程引用、归档历史可读、管理员拒绝、DTO 字段）。
- `npm run lint`、`npm run typecheck`、`npm run build`：通过。
- `npm run check:routes`：56 页路由映射通过；开发服务器下 `CHECK_HTTP=1 npm run check:routes`：56 个设计页全部 HTTP 200；B 页面 URL（07–10、23、29、35、38–40、46–47）单独请求均 200。

**剩余限制**

- `can()` 只判断资格；状态机、版本冲突、确认完整性等执行条件由阶段 03 命令层实现。归档项目的历史阅读已放行，写条件待命令拒绝。
- 非 B 模块的写入口仍直接调用通用 CRUD，部分仍用全局角色标签；详见[写入口迁移清单](01-写入口迁移清单.md)。
- 助教授权的授予/撤销命令（`course.staff.manage`）未实现，阶段 03/04 交付；当前演示数据中 ta-1 默认只读。
- 演示权限仍为前端门禁，不构成真实鉴权；旧浏览器缓存需清空 `groupproof-v1-workspace` 后才能看到新种子字段。

**下一阶段接口（02 可用）**

- `lib/access/policy.ts` 的 `can()` / `Action` / `Target` / `ProjectSummary` 为共享基础，阶段 02 版本模型的确认人与版本归属判断应复用同一资格函数。
- `Course.assistantGrants`、`Project.ownerId`、`Project.visibility` 已入领域类型与种子，阶段 02/03 的版本快照与命令可直接引用。
- 写命令迁移点清单作为阶段 03 的调用清单输入。

### 阶段 02：版本模型与成员确认（2026-10-06，待验收）

**实际变更**

- `types/domain.ts`：新增 `MemberConfirmation`、`Revision<T>`、`BaselinePayload`、`PlanPayload`、`BaselineRevision`、`PlanRevision`（含 `baselineRevisionId`）、`CourseRuleSnapshot`、`CourseRuleRevision`、`RuleChangeReview`；`MockData` 增加 `schemaVersion` 与 `baselineRevisions`/`planRevisions`/`courseRuleRevisions`/`ruleChangeReviews` 集合；`Project` 增加 `activeBaselineRevisionId`/`activePlanRevisionId`/`appliedCourseRuleRevisionId`/`sourceProjectId`。
- `lib/versioning.ts`（新增）：`migrateWorkspace`（增量迁移、幂等、格式错误报告）、`validateWorkspace`、`buildLegacyRevisions`（旧 frozen 基线/planConfirmed 计划/课程规则建立已发布历史快照，`legacy.confirmedUserIds` + `timestampUnknown`，不伪造确认时间）、`confirmationsComplete` / `confirmMember`（幂等，绑定 revisionId+contentVersion）/ `applyContentChange`（内容版本递增并清空确认）/ `applyMemberRoster`（名单变化使旧确认失效）、选择器 `activeBaseline` / `draftBaseline` / `activePlan` / `draftPlan` / `appliedCourseRule` / `confirmedUserIds` / `legacyConfirmedUserIds` / `ruleSnapshotOf`。
- `lib/api/mock-service.ts`：读取时执行迁移；迁移前把原始记录备份到 `groupproof-v1-workspace-legacy-backup`；格式错误报告并不覆盖原数据，仅本次会话回退演示种子。
- `mocks/seed.ts`：种子经 `buildLegacyRevisions` 生成已迁移状态（schemaVersion=1，legacy 快照），业务 ID 不变。
- 页面接入（08/09/10）：初始化团队确认逐步显示每人确认状态与时间（历史确认标注“未记录时间”），确认时写入绑定版本的 `MemberConfirmation`；需求基线“版本历史”区分“当前正式版本”/“待确认草稿”及确认进度；任务规划“确认进度”展示计划修订与逐人确认时间。
- `scripts/check-versioning.mjs`（新增）+ `npm run check:versioning`；`tsconfig.json` 开启 `allowImportingTsExtensions`（脚本可直接运行 TS 模块）。

**验证命令与结果（2026-10-06）**

- `npm run check:versioning`：47 项断言通过（迁移幂等、输入不改、旧字段/关联 ID 保留、不伪造历史时间、草稿不影响正式快照、确认绑定与重复确认、名单变化失效、选择器、格式错误报告）。
- `npm run check:access`：53 项断言仍通过；`npm run lint`、`npm run typecheck`、`npm run build`、`npm run check:routes` 通过；开发服务器下 56 页 HTTP 200，08/09/10 单独请求 200。

**剩余限制**

- 写入仍经通用 CRUD；`confirmMember` 等辅助由页面直接调用，受控命令化在阶段 03 完成。
- `RuleChangeReview` 类型已定义但尚无业务写入（阶段 09 使用）；`PlanPayload.criteria` 的 legacy 快照按任务筛选关联标准。
- 迁移失败时本次会话回退演示种子但保留原始记录（含备份键），后续写入可能覆盖主键，依赖备份键恢复。

**下一阶段接口（03 可用）**

- 阶段 03 命令层直接使用 `confirmMember` / `applyContentChange` / `applyMemberRoster` / `confirmationsComplete` 与 `Revision` 集合；命令需在写入前用 `can()` 复核资格并重查最新数据。
- `sourceProjectId` 供阶段 05 项目创建/重新开启的版本血缘使用。

### 阶段 03：业务命令与持久化（2026-10-06，待验收）

**实际变更**

- `lib/commands/core.ts`（新增）：`DomainError`（code/fieldErrors/latestVersion）、`CommandErrorCode`、`CommandContext`、`WorkspaceRepository`、`Command<I,O>` 与 `createCommandRunner` 执行器：输入校验（Zod strict）→ 读取最新状态与会话 → 权限/版本/业务状态校验 → 不可变生成新状态与日志 → 同一次保存 → 成功后更新缓存；本地串行队列；保存失败不更新缓存；actorId/now/logId 内部注入。
- `lib/commands/project.ts`（新增）：归档第一条完整链路 `archiveProject({ projectId, expectedVersion })` / `applyArchive`（NOT_FOUND→FORBIDDEN→VERSION_CONFLICT→INVALID_STATE 顺序校验，日志与主体同批保存）。
- `lib/commands/registry.ts`（新增）：命名命令注册表（15 个操作）；未实现操作返回 INVALID_STATE 明确错误并注明计划阶段（04–11），不伪造保存成功。
- `lib/commands/use-commands.ts`（新增）：公开 Hook，返回有类型操作与 pending；保存成功后更新 React Query，失败保留旧状态。
- 页面接入：29 项目设置“归档项目”走命令链路（重复提交禁用、版本冲突提示重新核对、存储失败提示重试）。
- `scripts/check-commands.mjs`（新增）+ `npm run check:commands`。
- 文档：[写入口迁移清单](01-写入口迁移清单.md)更新归档入口状态。

**验证命令与结果（2026-10-06）**

- `npm run check:commands`：35 项断言通过（普通成员 FORBIDDEN；active 拒绝/finalized 成功且 archived+版本递增；过期 expectedVersion 拒绝且不改对象与日志；保存失败不更新缓存、重试按最新版本；会话注入身份、输入指定他人被校验拒绝；未实现命令明确报错；授权变更后下一次操作读取最新授权）。
- `npm run check:access`（53）与 `npm run check:versioning`（47）仍通过；`npm run lint`、`npm run typecheck`、`npm run build`、`npm run check:routes` 通过；开发服务器下 56 页 HTTP 200。

**剩余限制**

- 仅归档完成全链路迁移；其余受控字段仍经通用 CRUD，对应命令已注册待 04–11 各阶段实现，迁移清单同步维护。
- 本地队列仅保证命令执行器内串行，不宣称生产多用户事务；HTTP 适配边界（服务端会话、数据库事务、条件版本更新）已注释约定。
- `useCommands` 目前只暴露已实现操作；错误反馈的字段级展示仅在校验错误结构中提供。

**下一阶段接口（04 可用）**

- 课程规则域命令 `course.settings.update` / `course.rules.edit` / `course.rules.publish` / `course.staff.manage` 已注册占位，阶段 04 按 `Command<I,O>` 实现并复用 `CourseRuleRevision` 快照与 `ruleSnapshotOf`。
- 执行器、DomainError 与 `useCommands` 为后续命令的统一入口。

### 阶段 04：课程规则与模板（2026-10-06，待验收）

**实际变更**

- `types/domain.ts`：新增 `CourseRulePayload`（结构化规则/模板载荷，含 rulesText、gradingNotes）。
- `lib/commands/course.ts`（新增）：`updateCourseSettings`（课程设置）、`saveCourseRuleDraft`（规则草稿，不覆盖已发布版本）、`publishCourseRules`（发布历史快照 + 兼容字段更新 + 关联小组复核提醒，重复发布不重复提醒）、`setAssistantPermissions`（助教授权白名单，撤销保留归属）；共享校验（原因必填、人数、日期顺序、阶段/材料完整）；`validateGrant` 白名单不含 `course.staff.manage`；ended 课程业务规则只读、授权撤销仍可处理。
- `lib/commands/registry.ts`：课程域四个命令接入注册表（移除占位）。
- `lib/commands/use-commands.ts`：暴露课程域四个有类型操作。
- `lib/versioning.ts`：选择器 `publishedCourseRule` / `draftCourseRule` / `courseRuleHistory`。
- 页面接入：47 规则模板改为“保存草稿 / 发布配置”双操作（编辑/发布分别判断 action），发布前显示下一版本与影响项目数；46 教学团队提供助教关联与三项授权勾选（撤销/授予写入日志）；40 学生总览读取最新已发布规则版本，草稿不外显。
- `scripts/check-course-rules.mjs`（新增）+ `npm run check:course-rules`。

**验证命令与结果（2026-10-06）**

- `npm run check:course-rules`：41 项断言通过（edit-only 助教可存不可发、跨课程拒绝、无原因/人数/日期/模板校验、发布保留 v1+真实提醒+不改基线+幂等、白名单与撤销、非助教不可关联、ended 只读/授权可处理、设置命令与版本冲突）。
- `check:access`（53）/`check:versioning`（47）/`check:commands`（35）无回归；lint/typecheck/build/check:routes 通过；开发服务器下 56 页 HTTP 200，40/46/47 单独 200。

**剩余限制**

- 评分说明仅管理展示（gradingNotes 传空串），不实现贡献或评分算法；阶段 09 用 `courseRuleHistory` 查询前后版本并处理项目影响确认。
- 发布提醒为演示 actionItems（type=`rule-review:<revisionId>`），真实通知渠道待后端；教师设置保存不再直接发提醒（按规格“仅发布后通知”）。

**下一阶段接口（05 可用）**

- `publishedCourseRule` / `CourseRuleRevision` 供阶段 05 项目创建套用课程规则版本（写入 `appliedCourseRuleRevisionId`）；`validateGrant` 与授权命令可复用。

### 阶段 05：课程项目创建（2026-10-06，待验收）

**实际变更**

- `lib/commands/project-create.ts`（新增）：`createCourseProject({ groupId, name, description, templateMode, expectedGroupVersion, expectedCourseRuleRevisionId })` → `CreateCourseProjectResult { project, alreadyExists }`。校验：group 目标 `project.create` 资格（不信任表单身份）→ 已有项目返回现有入口（不产生同组第二个项目）→ 课程 active → 已发布规则指针匹配（不匹配报 VERSION_CONFLICT 要求重新确认）→ expectedGroupVersion → 组人数落在规则范围。类型/截止日来源于规则快照；`appliedCourseRuleRevisionId` 记录采用版本；模板模式只控制可选里程碑初始化（每个里程碑归属新项目）；项目/里程碑/Group.projectId/日志同批提交。
- `lib/commands/registry.ts` / `use-commands.ts`：`project.create` 接入注册表与 Hook。
- 页面 35：创建走命令，展示采用的规则版本；重复点击禁用（pending）；alreadyExists 时展示并进入现有项目；无已发布规则时禁用并说明；失败保留表单输入。
- `scripts/check-project-create.mjs`（新增）+ `npm run check:project-create`。

**验证命令与结果（2026-10-06）**

- `npm run check:project-create`：28 项断言通过（组长资格/跨组拒绝、重复创建同一项目、无规则/ended/人数拒绝、规则版本与组版本冲突且不改 Group、course/blank 模板、里程碑归属与旧数据不改写、日志同批）。
- check:access/versioning/commands/course-rules（53/47/35/41）无回归；lint/typecheck/build/check:routes 通过；开发服务器下 56 页 HTTP 200，35 单独 200。

**剩余限制**

- 项目 ID 为演示生成（时间戳+随机段），真实服务应由后端分配；同组“当前项目”以 `Group.projectId` 单一指针判断。
- 页面 35 的 ownGroup 解析仍沿用现有入口逻辑；后续阶段（11 重新开启）将复用 `sourceProjectId` 血缘。

**下一阶段接口（06 可用）**

- 新项目 `setupStatus: not_initialized` / `appliedCourseRuleRevisionId` 就绪，阶段 06 需求基线在该项目上建立 `BaselineRevision`（复用 `applyContentChange`/`confirmMember`）。

### 阶段 06：需求基线管理（2026-10-06，待验收）

**实际变更**

- `lib/commands/baseline.ts`（新增）：基线服务命令 `createBaselineDraft` / `saveBaselineDraft` / `submitBaselineForConfirmation` / `confirmBaselineSelf` / `publishBaseline` / `forcePublishBaseline` 与 `getBaselineHistory` / `compareBaselines`（新增/删除/字段变更/模块关联/资料差异）。规则落实：正式版本不可原地编辑（提示创建变更草稿）；草稿修改递增 contentVersion 并清空确认；确认绑定 revisionId+contentVersion+roster（幂等、拒绝过期内容版本）；正常发布需全员确认，例外推进必填原因并审计未确认名单，两者同等硬校验（项目归属/模块/资料关联校验与双向关联归一化）；发布替换 Requirement/Module 投影、更新生效指针/baselineVersion/setupStatus/兼容 confirmedBy，保留旧快照，受影响任务当前验收标 outdated，引用旧基线的计划标记待复核（planConfirmed 回退）。
- `types/domain.ts`：`Revision` 增加 `reason?`（草稿变更原因）。
- 注册表/Hook：基线命令接入 `commands` 与 `useCommands`。
- 页面 09：编辑入口指向草稿（列表/详情优先展示草稿内容），提供“创建变更草稿”；保存/提交确认/本人确认/正常发布/例外推进均走命令，失败保留输入；历史 Tab 展示各修订的真实差异与确认进度。
- `scripts/check-baseline.mjs`（新增）+ `npm run check:baseline`。

**验证命令与结果（2026-10-06）**

- `npm run check:baseline`：46 项断言通过（草稿不改 v1、跨项目模块/文件拒绝、双向关联一致、确认幂等与过期内容拒绝、成员发布拒绝/无全员确认拒绝/例外推进原因与真实名单、v2 发布保留 v1+验收过期+未受影响项目不改写+计划待复核、差异与日志匹配）。
- 既有 5 套断言（53/47/35/41/28）无回归；lint/typecheck/build/check:routes 通过；开发服务器下 56 页 HTTP 200，09 单独 200。

**剩余限制**

- `expectedVersion` 统一取 project.version（聚合并发标记）；revision 级并发冲突、草稿多分支并行为后续阶段细化。
- 页面 09 已发布内容只读入口为“创建变更草稿”；初始化步骤 6 的旧 confirmSelf 仍写兼容字段，阶段 07 切换到基线命令。
- 任务执行模块对“验收过期”的消费点列入联调清单（阶段 13）。

**下一阶段接口（07 可用）**

- 初始化第六步复用 `createBaselineDraft` / `submitBaselineForConfirmation` / `confirmBaselineSelf` / `publishBaseline` / `forcePublishBaseline`；`getBaselineHistory` 供确认与历史展示。

### 阶段 07：项目初始化流程（2026-10-06，待验收）

**实际变更**

- `types/domain.ts`：新增 `SetupDraft`（步骤/表单/资料选择/粘贴来源/分析状态/冲突项/基线草稿引用/版本）；`MockData.setupDrafts`；迁移器补齐默认值。
- `lib/commands/setup.ts`（新增）：`saveSetupDraft`（课程硬约束校验：项目截止不晚于所采用规则；未保存内容留在表单层）、`advanceSetupStep`（前进按步骤校验：无有效资料不能进分析、分析未完成不能进冲突处理、冲突未决不能进审核、审核需至少一条需求与完整模块；后退不限制）、`runMockRequirementAnalysis`（可重复模拟分析，结果写入 06 基线草稿、稳定 ID 不产生重复数据、失败保留资料可重试、重跑使旧确认失效；冲突项由实际来源内容生成，无真实冲突可跳过）；导出 `conflictsResolved`。
- 页面 08 六步向导改为 SetupDraft 持久化编排：字段/来源/冲突选择刷新可恢复；第六步展示基线真实确认进度（含历史未记录时间标注），成员确认自身、组长发布/例外推进均走 06 命令；仅发布成功后冻结（完成依据 `activeBaselineRevisionId`）；只读教学人员无编辑/确认入口。
- `scripts/check-setup.mjs`（新增）+ `npm run check:setup`。

**验证命令与结果（2026-10-06）**

- `npm run check:setup`：34 项断言通过（草稿恢复字段/来源/选择/位置、课程硬约束、步骤推进校验、分析失败重试与幂等、审核变更使确认失效、未发布不冻结/发布后读取同一正式基线）。
- 7 套断言共 284 项全部通过（53/47/35/41/28/46/34）；lint/typecheck/build/check:routes 通过；开发服务器下 56 页 HTTP 200，08 单独 200。

**剩余限制**

- 分析为可重复的演示模拟（不解析真实文件字节），页面已明确标注；上传仍只保存元数据（阶段 10）。
- SetupDraft 的 expectedVersion 取 project.version；向导与步骤并发冲突为粗粒度。
- 第 1 步项目信息暂存于 SetupDraft，写回 Project.name/description 的受控命令在阶段 11（project.settings.update）。

**下一阶段接口（08 可用）**

- 初始化发布后的 `activeBaselineRevisionId` / `setupStatus=frozen` 为任务规划前置；`PlanRevision`（02）与 `project.plan.unlock` / `project.publish` 命令占位待阶段 08 实现。

### 阶段 08：任务规划与发布（2026-10-06，待验收）

**实际变更**

- `lib/commands/plan.ts`（新增）：`validatePlan(payload, baseline, members)` 独立校验器（归属/负责人/验收标准/整数权重/顶层 100%/子权重相等/父子树/父子环/依赖环/自引用/跨项目/悬空引用）与 `PlanValidationIssue`；命令 `createPlanDraft`（绑定已发布 baselineRevisionId）/ `savePlanDraft`（维护关联、contentVersion 递增、责任确认清空；保存只阻断硬性引用问题）/ `confirmAssignmentSelf`（幂等、绑定内容版本，无分配成员同样确认）/ `publishPlan` / `forcePublishPlan`（同等结构校验、真实签名与原因、审计未确认名单）/ `unlockPlan`（新草稿、旧历史保留）；发布原子生成 Task/AcceptanceCriterion 投影与正式计划快照（替换项目旧投影，无悬空标准 ID），并要求计划仍绑定生效基线。
- 页面 10（新 `ProjectPlanningView.tsx`）：任务编辑目标为 PlanRevision.payload，提供需求/模块/负责人/里程碑/依赖/验收标准的实际关联选择（不再静默默认第一条）；再生成建议只填未拆解需求（逻辑关联判重）；确认进度面板来自版本记录（替换本地布尔值）；校验问题定位展示；发布/例外发布/解锁分别反馈；执行视图（树/看板/列表）继续消费同一正式任务集合。
- `scripts/check-plan.mjs`（新增）+ `npm run check:plan`。

**验证命令与结果（2026-10-06）**

- `npm run check:plan`：43 项断言通过（权重/完整性、自引用/父子环/依赖环/跨项目/悬空、硬校验拒绝保存、确认幂等与过期拒绝、保存使旧确认失效、非组长拒绝、缺确认拒绝、例外不绕过结构校验、投影无重复/悬空、解锁保留历史、基线失效不能发布）。
- 8 套断言共 327 项全部通过（53/47/35/41/28/46/34/43）；lint/typecheck/build/check:routes 通过；开发服务器下 56 页 HTTP 200，10 单独 200。

**剩余限制**

- 任务执行/验收/贡献模块对计划版本变化的失效标记消费点待阶段 13 联调；里程碑存在性未纳入 validatePlan（里程碑归阶段 18/19 与后续模块）。
- 保存草稿对权重/完整性问题不阻断（仅提示），发布时强制通过；`expectedVersion` 仍取 project.version。
- 注册表 `project.publish` / `project.publish.override` 名称映射保留基线命令（基线优先），计划命令经 `useCommands` 提供。

**本批次（阶段 01–08）到此为止；阶段 09 及以后按新任务范围继续。**

### 阶段 09：课程规则变更处理（2026-10-06，待验收）

**实际变更**

- `lib/commands/rule-change.ts`（新增）：`RuleChangeImpact` 与纯比较器 `compareCourseRuleSnapshots`（结构化字段/材料集合真实增删改、模板变化、真实超期里程碑）；`getRuleChangeImpact(projectId, toRevisionId)`（缺版本返回明确错误；未记录已采用版本时以目标版本为准）；`applyCourseRuleChange({ projectId, toRevisionId, expectedVersion })` → `RuleChangeReview`：仅组长（project.rules.apply）、版本与目标发布校验、同版本重复确认幂等、更新适用指针与课程级约束（项目截止）、完成复核待办、生成带目标 ID 的待调整事项（材料缺口/超期里程碑/计划复核）、需要需求变动时创建并链接基线变更草稿；不自动移动里程碑、不改写正式需求/计划。
- 页面 38：移除固定发布时间/格式/“顺延 10 天”文案，改由快照比较渲染：来源版本与待复核版本（发布者/时间，历史迁移标注）、变化字段对照、实际影响分类与关联调整入口（需求/计划/里程碑/资料/小组）、组长确认入口与已确认状态；教学人员/成员可读，适用由组长推进。
- `scripts/check-rule-change.mjs`（新增）+ `npm run check:rule-change`。

**验证命令与结果（2026-10-06）**

- `npm run check:rule-change`：39 项断言通过（只改人数无截止/格式变化、提前截止只报真实超期且不改日期/计划、材料新增生成缺口待办且指针/截止一致、v1→v3 比较与重复确认幂等、普通成员/其他组长/过期版本/失效版本拒绝、模板变化分类）。
- 9 套断言共 366 项全部通过（53/47/35/41/28/46/34/43/39）；lint/typecheck/build/check:routes 通过；开发服务器下 56 页 HTTP 200，38 单独 200。

**剩余限制**

- 待调整事项为演示 actionItems；实际里程碑/计划/基线修改由各所属命令落实（部分命令在 10/11 阶段补全）。
- 材料缺口按文件名匹配判断；模板预览读取课程快照，未做逐字段时间线 UI。

**下一阶段接口（10 可用）**

- `RuleChangeReview` 与 `getRuleChangeImpact` 可供教师端/阶段 13 验收查询；阶段 10 完成 `project.files.write` 命令后，材料缺口待办可直接落到资料命令。

### 阶段 10：项目资料与文件版本（2026-10-06，待验收）

**实际变更**

- `lib/commands/files.ts`（新增）：统一文件契约 —— `validateUploadSize`（0–50MB）与格式白名单一个校验器；`uploadProjectFile` / `replaceProjectFile`（files.write + active 项目；同名逻辑文件版本递增、旧 current→superseded、当前指针唯一；跨项目/异名替换拒绝；元数据保存原始 sizeBytes + MIME，兼容旧 size 文本）；`listProjectFiles` / `getFileVersions`（content.read）；`getFilePreview` / `getFileDownload` 返回明确 Mock 描述（标注模拟，未存真实字节）；代码注释写入真实文件服务适配边界（上传会话/完成确认/预览下载输出/服务端授权/条件版本更新）。
- `types/domain.ts`：`FileRecord` 追加 `sizeBytes?`/`mimeType?`。
- 页面接入：23 资料中心上传/替换走命令并逐文件反馈（不一概报成功），版本历史按逻辑文件展示，新增预览/下载（模拟）入口与 Mock 范围标记；08 初始化上传接入同一 FileService（逐文件反馈）。
- `scripts/check-files.mjs`（新增）+ `npm run check:files`。

**验证命令与结果（2026-10-06）**

- `npm run check:files`：32 项断言通过（50MB 边界与失败不改 current、同名替换版本与快照引用不变、跨项目/异名/缺对象拒绝、公开总览用户不能下载、部分失败逐个反馈、重复提交版本冲突拦截、归档只读、无写资格拒绝、Mock 描述）。
- 10 套断言共 398 项全部通过；lint/typecheck/build/check:routes 通过；开发服务器下 56 页 HTTP 200，23/08 单独 200。

**剩余限制**

- 文件字节不落盘（仅元数据）；预览/下载为模拟描述；真实上传完成确认、断点/重试由后端适配器承接。
- 正式基线 sourceFileId 引用保留历史 ID 不改写；替换后“是否需要基线变更”由阶段 09 生成的待办提示，不自动改 snapshot。

**下一阶段接口（11 可用）**

- `listProjectFiles`/`getFileVersions`/预览下载契约供阶段 13 接口交接复用；阶段 11 实现 `project.settings.update` / `project.reopen` 后完成项目设置与生命周期命令闭环。

### 阶段 11：项目设置与生命周期（2026-10-06，待验收）

**实际变更**

- `lib/commands/project.ts`：`updateProjectSettings`（字段白名单 name/language/visibility，strict 拒绝成员/归属/版本/生效版本等任意 patch；`project.settings.update` 资格与版本校验）；`reopenProject`（`project.reopen` 资格；active 源拒绝；重复请求返回已有修订不生成多份；完整 ID 映射克隆模块/需求/任务/父子/依赖/标准/里程碑/证据/验收，外键全部指向新修订；复制验收标 outdated 且清空人为确认；新修订基线/计划为草稿且确认为空，`sourceProjectId` 指向源；Group.projectId/日志/实体同批保存；源项目与报告/贡献历史保持原位）；`assertProjectWritable` 统一拒绝归档/定稿对象的业务写入（baseline/plan/setup/files/settings 全部接入）。
- 页面 29：设置保存走命令（名称/语言/可见范围）；项目类型只读（来自课程规则）；集成开关改为受控状态展示，不再布尔 patch；归档继续走 03 命令。页面 39：重新开启走 `reopenProject`（修订标签/原因/是否保留执行历史），默认保留并提示需重新确认。
- `scripts/check-lifecycle.mjs`（新增）+ `npm run check:lifecycle`；`check-commands` 未实现占位行为改为独立用例（注册表命令已全部实现）。

**验证命令与结果（2026-10-06）**

- `npm run check:lifecycle`：44 项断言通过（设置资格/白名单/版本、归档状态机与归档后写拒绝、重开资格/active 源/重复请求、外键完整无悬空、验收 outdated 与确认清空、历史不覆盖、Group 指针原子、保存失败回滚、不保留模式）。
- 11 套断言共 443 项全部通过（53/47/36/41/28/46/34/43/39/32/44）；lint/typecheck/build/check:routes 通过；开发服务器下 56 页 HTTP 200，29/39 单独 200。

**剩余限制**

- 成员变更、集成开关、报告生成仍属对应模块入口，本阶段只收编设置字段白名单与生命周期；重开保留进度快照但标记待复核，新计划发布前不声称可执行。

**下一阶段接口（12 可用）**

- `Project.sourceProjectId` / 生命周期状态机与 `assertProjectWritable` 供总览统计区分修订来源；阶段 12 统计口径应排除待复核新修订的旧快照进度。

### 阶段 12：项目总览与统计（2026-10-06，待验收）

**实际变更**

- `lib/overview.ts`（新增）：统一派生口径 —— `weightedProgress`（分母 0 返回 null）、`currentTasks`（正式计划任务集合 + 执行投影进度）、`deriveProgress`（顶层权重总进度；core 模块根任务归一核心进度，子任务不重复计权）、`getProjectSummary`（summary.read，先填派生进度再返回五字段白名单 DTO）、`getProjectOverview`（content.read 私有 ViewModel：版本/进度/本人任务/里程碑/待处理/真实动态/教学只读标记/草稿预览标记）。
- 页面 07：读取统一模型；区分未初始化/待确认/计划草稿/复核中/已发布/已定稿/已归档；分母 0 显示“暂无计划”；修订来源与待复核提示；教学人员不显示本人学生操作；新增“版本与计划”面板（基线/计划/规则版本）。
- 公开总览组件（07/21–29 入口）改用 `getProjectSummary`；`core-model` 进度写入复用 `weightedProgress` 统一口径。
- `scripts/check-overview.mjs`（新增）+ `npm run check:overview`。

**验证命令与结果（2026-10-06）**

- `npm run check:overview`：30 项断言通过（父子不重复计权、根任务同步、空计划 null、核心筛选/普通模块不影响、公开五字段/私有拒绝、教学只读、状态随版本/生命周期/规则复核变化）。
- 12 套断言共 473 项全部通过；lint/typecheck/build/check:routes 通过；开发服务器下 56 页 HTTP 200，07 单独 200。

**剩余限制**

- 公开 DTO 的 `progress` 仍为 number（合同字段），无计划时回退存储快照；“暂无计划”文案在私有模型/页面呈现。
- 动态取自 GitHub/证据/日志真实记录；任务执行模块的进度写入仍经 `recordTaskProgress`（口径已统一），命令化迁移见清单。

**下一阶段接口（13 可用）**

- `getProjectSummary`/`getProjectOverview`/`deriveProgress` 为验收统计口径；阶段 13 可据此核对总览与执行视图一致性并汇总后端接口交接。

### 阶段 13：功能验收与后端接口交接（2026-10-06，待验收）

**实际变更**

- `scripts/check-e2e.mjs`（新增）+ `npm run check:e2e`：服务层夹具端到端走查（教师发布规则 → 组长创建项目（套用规则版本）→ 六步初始化与基线发布 → 计划草稿/责任确认/发布 → 执行视图与统计一致性 → 规则真实差异与适用确认 → 资料版本/设置/存储失败/归档只读/重开）。浏览器交互无法在本环境脚本化，按阶段约定以服务层夹具验证并记录。
- 新增[后端接口交接表](13-接口交接表.md)：项目/创建/基线/计划/课程规则/助教授权/规则变更/资料/初始化/统计的完整操作契约（输入白名单、返回、资格、前置状态、expectedVersion、幂等与关联变更、错误码）+ 真实服务待办清单。
- 阶段索引状态：01–12 标为已完成（均附代码与断言证据）；13 待验收；14–15 保持待开发（依赖功能验收与视觉稳定）。

**验收证据（2026-10-06，Node.js 22.22.3）**

- 13 套断言共 513 项全部通过：access 53 / versioning 47 / commands 36 / course-rules 41 / project-create 28 / baseline 46 / setup 34 / plan 43 / rule-change 39 / files 32 / lifecycle 44 / overview 30 / e2e 40。覆盖测试场景：账号×资源×操作矩阵、跨组/跨课程、助教授予/撤销、公开 DTO、正常/例外发布、旧确认/旧版本、硬约束、历史保留、原子创建/复制、存储失败、重复提交、刷新恢复（持久化）、迁移幂等、真实规则差异、资料版本、归档只读、重开、视图同步、未实现服务不伪造成功。
- 工程检查：`npm run lint`、`npm run typecheck`、`npm run build`、`npm run check:routes` 通过；开发服务器 `CHECK_HTTP=1 npm run check:routes`：56 页全部 HTTP 200；B 页面（07–10、23、29、35、38–40、46–47）直接 URL 复查均 200。

**剩余限制**

- 浏览器交互类验收（键盘操作、焦点、窄屏布局、点击式保存/重试记录）沿用历史走查记录（FRONTEND_STATUS），本轮新增页面以服务层夹具 + HTTP 200 + 代码级无障碍属性（aria/label/disabled）验证；完整人工交互验收待用户执行。
- Mock 与真实服务边界见交接表；演示权限不构成真实鉴权。

**下一步**

- 功能闭环与模型/接口已稳定（交接表就绪）；阶段 14（UI/UX 重新设计）待用户完成功能验收后按新任务范围启动。

### 阶段 14–15：UX 改版与动效（2026-10-06，本轮范围，待验收）

**实际变更**

- 定向复核修复：`lib/ux/navigation.ts`（导航/横幅跟随当前项目与课程对象，任务三视图合并单入口、旧链接兼容）、`lib/ux/stats.ts`（教师统计口径：100% 进度≠完成/验收/定稿，已定稿与待定稿分列，"已验证模块"改"进度满模块"）、页面 10 保存/确认/发布防重复提交（pending 禁用）。
- 规范：[14-UX设计规范.md](14-UX设计规范.md)（信息架构、四类模板、Tokens 映射、组件状态表、三代表页线框与交互说明、56 页映射表含规范/代码/浏览器/负责人/剩余问题列、其他成员接入清单）、[15-动效规范.md](15-动效规范.md)（运动 Tokens、组件运动规则、减少动效、硬性规则）。
- 实现：`app/globals.css` 新基线 Tokens（#F8FAFC/#0F172A/#0369A1、间距 4–32、圆角 6/8、动效 Tokens 与 prefers-reduced-motion 降级、Feedback/SaveState/字段错误类）；`components/ui/button.tsx` 基线色 + loading/aria-busy；`components/common.tsx` Feedback/SaveState；project-core/governance 模块 CSS 主色对齐；ProjectSupportView/CourseView 主操作与链接常量对齐。
- 代表页（14B）：07 总览、10 任务规划（发布条件清单/校验定位/防连点/SaveState）、47 教师规则配置（变更预览前→后/影响对象/复核要求/编辑发布分离）。
- 推广（14C）：08/09/23/29/35/38–40/46 统一主操作、链接、反馈（29/38 接入 Feedback/SaveState）。
- 动效接入（15）：Button/Feedback/SaveState/代表页与推广页；截图 `docs/design/screenshots/`（stage14-*/stage15-*，实现截图标识；参考稿为规范内线框标识）。

**验证命令与结果（2026-10-06，实际运行）**

- `npm run check:ux`：16 项断言通过（导航上下文/任务合并入口/统计口径回归）。
- `npm run check:browser`（Chrome headless + CDP，界面真实事件）：33 项断言通过 —— 非 project-1 导航与视图切换、创建项目、初始化六步、基线确认/发布、任务计划确认/发布、保存失败（存储失败模拟）保留输入、版本冲突保留输入、重复提交仅生效一次、刷新恢复字段与步骤、只读教师/公开总览/助教边界、375/768/1024/1440px 无横向溢出、键盘焦点、减少动效即时化、快速重复点击不重复开表单。
- 业务断言 14 套共 529 项无回归（access 53/versioning 47/commands 36/course-rules 41/project-create 28/baseline 46/setup 34/plan 43/rule-change 39/files 32/lifecycle 44/overview 30/e2e 40/ux 16）。
- `npm run lint`、`npm run typecheck`、`npm run build`、`npm run check:routes` 通过；56 页路由与 HTTP 全绿。

**剩余限制**

- `ui-ux-pro-max` 技能不在环境中，规范按任务基线直接编制并标注；无设计工具 PNG 参考稿，参考稿=规范线框、实现截图=Chrome 实拍，分别标识。
- 其他成员页面规范覆盖完成、代码待其负责人按 [接入清单](14-UX设计规范.md) 落地；映射表状态列由各负责人更新，不记为全项目代码完成。
- 浏览器环境偶发残留 Chrome 进程会导致注入失败（清理后重跑即恢复），已记录在验证工具说明。

**交付位置**

- 规范：`docs/development-stages/14-UX设计规范.md`、`docs/development-stages/15-动效规范.md`；阶段报告：`stage-reports/14-*.md`、`15-*.md`。
- 截图：`docs/design/screenshots/`（stage14-<page>-<state>.png / stage15-*.png）。

### 2026-10-08 迭代：登录鉴权、注册闭环、用户数据库与全站语言（实施方案 v1.1 P0–P5）

- 范围与完成内容、验证结果（后端 pytest 78 项 + `check:auth`/`check:i18n`/`CHECK_HTTP=1 check:routes` + 业务回归 529 项）与剩余限制见 [迭代总结](stage-reports/2026-10-08-登录鉴权注册与语言.md)。
- 关键位置：`server/`（FastAPI + Alembic 迁移 + 字段字典）、`app/[[...slug]]/page.tsx`（页面门禁）、`features/auth|account`、`components/account-shell.tsx`、`i18n/` + `messages/` + `components/language-switcher.tsx`、`scripts/check-auth.mjs|check-i18n.mjs`。
- 未联调（缺凭据/配置）：真实 Google OAuth、真实学校邮件；业务数据表迁移与业务视图词条提取继续按[接口交接表](13-接口交接表.md)与迭代总结推进。
- 同日追加：账号密码注册/登录窗口（用户名/邮箱 + 密码，bcrypt 入库），见[账号密码登录总结](stage-reports/2026-10-08-账号密码登录.md)；后端 pytest 89 项通过。
- 2026-10-09：注册失败根因修复（R0）与独立邮箱注册/密码恢复/历史账户补验（R1），见[注册故障修复与独立邮箱注册总结](stage-reports/2026-10-09-注册故障修复与独立邮箱注册.md)；pytest 107 项、E01–E22 矩阵（E21 未验证）。


## 不同分支与工作树

文档使用相对链接并纳入 Git。新分支从包含这些文件的提交创建；已有分支同步相应文档提交。

2026-10-06 检查时，仓库原先仅跟踪 AGENTS.md，应用源代码、依赖清单和背景文档仍是未跟踪文件。本次文档归档不等于应用源码已纳入 Git。使用独立工作树或克隆前，必须确认所需源代码与依赖文件也在该 checkout 中；同一实际项目目录中的聊天可直接读取现有代码。

## 可复制给另一个 agent 的启动任务

```text
请在 GroupProof 实际项目根目录工作。
依次读取 AGENTS.md、README.md、docs/development-stages/PROJECT_CONTEXT.md、
FRONTEND_STATUS.md、FRONTEND_IMPLEMENTATION_PLAN.md，以及
docs/development-stages/README.md。

本次任务：实施阶段 01-权限矩阵与权限判断。
读取该阶段文档、前置说明和相关源码，先核对实际完成情况，再实施。
沿用当前 UI；权限按当前用户与目标资源关系判断，助教按课程授权，
同课程其他小组仅读取公开总览。遵循阶段规定的数据类型、接口和验收条件。
完成后记录实际变更、测试结果、剩余限制和下一阶段接口；
本次范围为指定阶段，后续阶段按新的任务范围继续。
```

分配其他阶段时替换任务名称及范围；无需让 agent 在开始前逐文件通读所有业务源码。
