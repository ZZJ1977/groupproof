# GroupProof V1 前端实施计划

## 当前仓库与依据

- 仓库在实施前为空目录，无现有代码、依赖或 CodeGraph 索引。
- 页面布局、导航、文案和视觉以《GroupProof UI 设计合集 56 页》为依据；业务状态、权限与 V1 边界以《完整系统设计与实现方案 V1.0》为依据。
- 本阶段只交付可运行的 Mock 前端。OAuth、FastAPI、数据库、存储、GitHub、飞书、AI 与 SSE 保留适配边界，不接入真实服务。

## 技术与结构

- Next.js App Router、TypeScript strict、Tailwind CSS、shadcn/ui 风格的本地组件。
- TanStack Query 管理服务层查询与更新；React Hook Form + Zod 处理关键表单；next-intl 管理中文默认文案。
- `app/` 放路由入口；`components/` 放布局和基础控件；`features/` 放业务页面；`types/` 放领域模型；`mocks/` 放关联样本；`lib/api/` 放异步 Mock Adapter 与查询 Hook。
- 全局布局分学生工作区、项目工作区、教师课程区和 Admin 后台。教师导航固定为课程总览、小组、待处理、报告、课程设置；Admin 保持用户、教师审核、课程、系统日志、AI 使用与异常访问的紧凑治理视图。
- 共用 `PageHeader`、Breadcrumb、状态标记、进度条、表格/筛选、空/加载/错误状态、Dialog、Drawer、操作反馈。任务树、看板、列表只读取同一 Task 数据集。

## Mock 数据与交互

- 稳定 ID 关联 `Course → Group → Project → Requirement → FunctionalModule → Task/Subtask → AcceptanceCriterion → Evidence → Verification → Contribution → Report`；里程碑、通知、待处理、GitHub/飞书记录引用同一实体 ID。
- 状态机包含 Task 五态、Verification 四种判断、Evidence 四态、Project 生命周期和 Action Item 四态。AI 的 Passed 仍需人工确认；正式证据只可撤回/作废；100% 进度不自动提交任务。
- Mock API 以 Promise 返回结构化数据和 `version`；变更通过 Query 失效更新相关视图。未来 FastAPI 替换 Adapter 时保留页面调用约定。
- Mock 当前用户可切换 student、leader、teacher、ta、admin；导航与动作按上下文权限展示。Admin 默认只显示元数据和审计信息。
- 核心变更：资料导入与基线确认、任务规划与状态、证据提交和确认、逐项 AI 验收与人工确认、课程组队与审批、教师处理、Admin 教师审核。筛选、Tab、Dialog、Drawer、下拉菜单和表单可操作。

## 56 页路由映射

> UX 改版说明（阶段 14）：任务树/看板/列表在工作区导航中合并为单一“任务”入口（默认 `?view=tree`），页内切换视图；下列 11–13 旧链接（`?view=tree|board|list`）保持有效并继续映射到同一任务数据集。项目/课程导航与横幅名称跟随当前对象（不再固定 project-1/course-1 示例）。

演示 ID 使用 `project-1`、`course-1`、`group-1`、`task-1` 和 `member-1`；列表与详情仍使用参数化路由。任务三视图共享一个路由和数据源。

> 2026-10-08 登录鉴权迭代：页 01 登录仅保留 Google 入口（“完善个人资料/验证邮箱”入口已移除）；页 02/03 的 `/onboarding/*` 为旧链接兼容别名，统一跳转个人中心并经相同门禁。个人中心等新增系统页列于表后，不冒充原 56 个设计页。

| 页 | 设计页 | 前端路由 |
|---:|---|---|
| 01 | 登录 | `/login` |
| 02 | 完善个人资料 | `/onboarding/profile` |
| 03 | 学校邮箱验证 | `/onboarding/email-verification` |
| 04 | 首页 | `/home` |
| 05 | 通知 | `/notifications` |
| 06 | 待处理事项 | `/action-items` |
| 07 | 项目总览 | `/projects/project-1` |
| 08 | 项目初始化 | `/projects/project-1/setup` |
| 09 | 需求基线 | `/projects/project-1/requirements` |
| 10 | 任务规划 | `/projects/project-1/planning` |
| 11 | 任务树 | `/projects/project-1/tasks?view=tree` |
| 12 | 任务看板 | `/projects/project-1/tasks?view=board` |
| 13 | 任务列表 | `/projects/project-1/tasks?view=list` |
| 14 | 任务详情 | `/projects/project-1/tasks/task-1` |
| 15 | 提交任务 | `/projects/project-1/tasks/task-1/submit` |
| 16 | 证据完整性检查 | `/projects/project-1/tasks/task-1/evidence-check` |
| 17 | AI 验收 | `/projects/project-1/tasks/task-1/verification` |
| 18 | 里程碑总览 | `/projects/project-1/milestones` |
| 19 | 里程碑详情 | `/projects/project-1/milestones/milestone-1` |
| 20 | 证据中心 | `/projects/project-1/evidence` |
| 21 | GitHub 页面 | `/projects/project-1/github` |
| 22 | 飞书协作记录 | `/projects/project-1/collaboration` |
| 23 | 文件资料 | `/projects/project-1/files` |
| 24 | 讨论区 | `/projects/project-1/discussions` |
| 25 | 贡献总览 | `/projects/project-1/contribution` |
| 26 | 成员贡献详情 | `/projects/project-1/contribution/member-1` |
| 27 | 报告预览 | `/projects/project-1/reports` |
| 28 | 报告导出 | `/projects/project-1/reports/export` |
| 29 | 项目设置 | `/projects/project-1/settings` |
| 30 | 个人动态 / 我的记录 | `/activity` |
| 31 | 我的课程 | `/courses` |
| 32 | 加入课程 | `/courses/join` |
| 33 | 课程内组队 | `/courses/course-1/groups` |
| 34 | 小组成员管理 | `/courses/course-1/groups/group-1` |
| 35 | 创建课程项目 | `/courses/course-1/projects/new` |
| 36 | 更换组长 | `/courses/course-1/groups/group-1/change-leader` |
| 37 | 退出小组申请 | `/courses/course-1/groups/group-1/leave` |
| 38 | 课程规则变更 | `/courses/course-1/rule-changes` |
| 39 | 项目重新开启 | `/courses/course-3/projects/reopen` |
| 40 | 课程规则 / 模板总览 | `/courses/course-1/rules` |
| 41 | 教师课程总览 | `/teacher/courses/course-1` |
| 42 | 教师小组列表 | `/teacher/courses/course-1/groups` |
| 43 | 教师查看小组概况 | `/teacher/courses/course-1/groups/group-1` |
| 44 | 教师待处理中心 | `/teacher/courses/course-1/actions` |
| 45 | 教师报告与贡献汇总 | `/teacher/courses/course-1/reports` |
| 46 | 教师课程设置 | `/teacher/courses/course-1/settings` |
| 47 | 教师课程规则模板配置 | `/teacher/courses/course-1/rules` |
| 48 | 教师成员变更审批 | `/teacher/courses/course-1/member-changes` |
| 49 | 教师申诉处理 | `/teacher/courses/course-1/appeals` |
| 50 | 教师课程文件管理 | `/teacher/courses/course-1/files` |
| 51 | Admin 用户管理 | `/admin/users` |
| 52 | 教师审核 | `/admin/teacher-verifications` |
| 53 | 课程管理 | `/admin/courses` |
| 54 | 系统日志 | `/admin/logs` |
| 55 | AI 使用情况 | `/admin/ai-usage` |
| 56 | 异常 / 访问审批 | `/admin/access-requests` |

## 新增系统页（2026-10-08，用户账户与注册审核）

| 页面 | 路由 | 门禁 | 说明 |
|---|---|---|---|
| 个人中心入口 | `/account` | 有会话 | 跳本人当前步骤；已激活默认到资料页 |
| 个人中心基本资料 | `/account/profile` | 有会话且未停用 | 只操作本人；字段白名单 + expectedVersion |
| 学校邮箱绑定/验证/更换 | `/account/email` | 有会话且未停用 | 发送前需满足资料要求；换绑独立流程 |
| 身份确认（学生/教师）（2026-10-10 更名，原“完成 / 教师审核”） | `/account/status` | 有会话 | 只显示本人必要信息与核验摘要；含教师审核进度与刷新入口 |
| 账号安全（可选阶段；登录邮箱补验/改密） | `/account/security` | 有会话 | 历史未验证登录邮箱的受限补验入口（2026-10-09）；可选不计入注册必填进度（2026-10-10） |
| 密码重置 | `/reset-password` | 公开 | 邮件链接 fragment 令牌，页面内即刻清除后经 POST 提交（2026-10-09） |
| 旧资料页别名 | `/onboarding/profile` | 同门禁 | 重定向 `/account/profile` |
| 旧邮箱验证页别名 | `/onboarding/email-verification` | 同门禁 | 重定向 `/account/email` |
| 语言 Cookie 接口 | `POST /api/locale` | 公开 | 服务端写 `gp_locale`（白名单值） |
| 注册三步/找回密码弹窗 | `/login` 内 | 公开 | 邮箱→验证码→建档；忘记密码统一安全反馈（2026-10-09） |
| 未知路由 | — | — | 404，不加载工作区 |

认证与账户接口（Google OAuth、session、/me、/admin 治理）经同源代理 `/api/v1/*` 访问 FastAPI，契约见 [`docs/development-stages/13-接口交接表.md`](./docs/development-stages/13-接口交接表.md)。

## 实施顺序

1. 初始化工程、设计变量、角色布局、导航、类型、Mock Adapter 与共用控件。
2. 登录、资料、验证、首页、课程与小组。
3. 项目总览、六步初始化、需求基线与任务规划。
4. 共享任务视图与详情、里程碑、提交、证据、逐项验收。
5. GitHub、飞书只读记录、文件、讨论、贡献、报告和设置。
6. 教师 10 页与 Admin 6 页。
7. 执行 lint、typecheck、build，检查导航和核心交互，记录 Mock 与待集成项到 `FRONTEND_STATUS.md`。
