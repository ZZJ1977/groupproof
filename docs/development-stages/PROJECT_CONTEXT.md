# GroupProof 项目背景与已确认决策

更新日期：2026-10-06。本文是新开发 agent 的背景入口，记录已有代码事实与用户确认的目标；目标条款尚待阶段实施和验收。

## 产品与用户

GroupProof 面向课程小组项目，以“需求 → 任务 → 验收标准 → 证据 → 人工确认 → 贡献与报告”建立工作追溯。学生与组长完成项目协作，教师与助教管理或查看所属课程，管理员承担平台治理。

成员 B 是开发分工：负责项目建立与规则管理，以及全项目 UI/UX 设计规范。B 的业务页面覆盖 07–10、23、29、35、38–40、46–47。任务执行、证据与 AI 验收、贡献算法、报告生成等模块由相应负责人维护，B 负责其上游契约与变更影响。

## 当前架构

- Next.js App Router 使用一个 catch-all 路由入口；lib/routes.ts 将 URL 映射到页面编号，features/route-dispatcher.tsx 选择页面与已有工作区布局。
- features/ 按核心入口、项目核心、项目支持、课程、教师与管理员组织。
- types/domain.ts 定义实体，mocks/seed.ts 提供稳定 ID 的演示数据。
- lib/workspace.tsx 使用 React Query 保存工作区缓存，提供角色切换及通用集合操作。
- lib/api/mock-service.ts 从浏览器 localStorage 读写整个工作区；当前没有真实后端、数据库、对象存储和多用户鉴权。
- 现有基础控件、全局样式和模块样式可复用；功能阶段保持当前视觉风格。
- Node.js 22.22.3 / npm 10.9.8 已用于安装及启动验证。README 写有 Node.js 20+ 的运行要求；阶段测试若使用原生 TypeScript 类型擦除，按 Node.js 22 环境执行。

## 领域关系与现有状态

Course → Group → Project → Requirement → FunctionalModule → Task/Subtask → AcceptanceCriterion → Evidence → Verification → Contribution → Report。Milestone、通知和待处理引用这些实体。

现有 Project.setupStatus 为 not_initialized、draft、pending_confirmation、frozen；lifecycle 为 active、finalized、archived。Task 包含 not_started、in_progress、pending_submission、pending_verification、completed。Evidence 和 Verification 的状态以 types/domain.ts 为准。

正式证据保留历史；AI 判断不是人工确认；进度 100% 不等于任务已提交或已完成验收。任务树、看板、列表共用一个 Task 数据集。

## 已经确认的开发决策

1. 先完成前端功能与接口设计，再重新设计 UI，最后补充动效。
2. 新视觉采用专业教学管理台方向；B 交付统一规范与参考，组件和其他页面代码由对应开发者实现。
3. 团队共同编辑、确认责任；组长推进基线与计划发布。例外推进需要原因与审计，不代替未确认成员签名。
4. 项目“课程内可见”只向同课程其他小组公开 ID、名称、简介、总体进度、生命周期；需求、任务、资料、证据和成员确认信息保持在成员与所属教学团队范围。
5. 助教需要真实的课程内归属，默认只读。课程教师分别授予课程设置修改、规则编辑、规则发布权限；助教不管理授权本身。
6. 项目内组长按 Group.leaderId 判断，不能由全局 leader 标签推断。无小组项目明确记录 ownerId。
7. 正式基线和计划采用版本快照，新内容先进入草稿；确认绑定具体版本；发布后更新生效版本及相关失效标记。
8. 项目采用指定课程规则版本，课程更新通过真实差异和影响说明处理；模板版本不会静默改写正式基线。
9. 权限、业务状态、结构完整性、版本冲突分别校验；写操作和相关日志通过受控命令提交。
10. 当前文件上传仍以 Mock 元数据与演示操作为范围；真实字节存储、预览和下载在后端接口交接中明确。

## 实际代码中的已知缺口

以下为阶段 01（权限矩阵与权限判断，2026-10-06）实施后的状态：

- [已统一] RouteDispatcher 与 useProjectCore 的身份判断；阅读资格统一走 `lib/access/policy.ts`，布局选择与访问资格分离。
- [已统一阅读门禁] 项目支持页此前只判断项目存在；现已按 summary/content 资格判断，但非 B 页面的写入口仍待迁移。
- [部分修复] setRole 的 ta 已改为独立账号 ta-1 并归属 course-1（assistantGrants）；助教授权的授予/撤销命令待阶段 03/04 实现。
- ProjectPlanning.assignmentConfirmed 是页面内状态，未保存每个成员对具体计划版本的确认。
- 需求变更直接修改现有对象，独立草稿和不可变历史快照需补齐。
- RuleChanges 存在固定发布时间、提交格式和“里程碑顺延 10 天”等文案；目前主要更新项目截止日期，需改为实际差异和影响。
- CourseRules 的部分模板说明固定，默认里程碑还会引用现有项目数据，需改为课程模板版本。
- 工作区先更新缓存再异步保存，保存失败的处理、原子变更和受控入口需要完善。
- 文件操作主要保存元数据；不同上传入口的格式和大小校验需要统一。

这些是代码检查结果与待完善方向，不意味着全部问题已经修复。

## 背景资料的边界

[历史前端实施计划](../../FRONTEND_IMPLEMENTATION_PLAN.md)引用《GroupProof UI 设计合集 56 页》和《完整系统设计与实现方案 V1.0》，本次仓库检索未找到原文。不要声称已经读取这些原始文档。需要原文才能决定的新业务条款应明确说明缺失信息；用户已经确认的上述决策继续作为本次实施依据。

[前端状态](../../FRONTEND_STATUS.md)记录的是原型能力与历史验证。阶段是否完成以实际代码、[阶段索引](README.md)和新的验收记录共同判断。

## 源码定位

- [领域模型](../../types/domain.ts)
- [演示数据](../../mocks/seed.ts)
- [工作区与缓存](../../lib/workspace.tsx)
- [Mock 读写](../../lib/api/mock-service.ts)
- [URL 映射](../../lib/routes.ts)
- [页面分发](../../features/route-dispatcher.tsx)
- [项目核心能力](../../features/project-core/core-model.ts)
- [项目创建与课程流程](../../features/course/CourseView.tsx)
- [项目支持页面](../../features/project-support/ProjectSupportView.tsx)
- [教师设置与规则](../../features/governance/TeacherViews.tsx)

## 当前可复用的验证证据

2026-10-06 修复 package-lock.json 缺失的 next-intl 间接 @swc/helpers 条目后，实际安装、构建（含 lint/类型检查）、路由映射及临时开发服务器 56 页 HTTP 200 检查通过。阶段 01 后，`npm run check:access` 权限矩阵 53 项断言通过（证据与限制见[阶段总览](README.md)）。HTTP 200 不能替代功能、权限与版本语义测试。
