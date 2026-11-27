# GroupProof 前端页面地图与路由规范

> 更新日期：2026-11-27 · 代码基线：`origin/develop == origin/main`（Alembic 迁移头 `0047`）  
> 返回 [项目首页](../../README.md) · 另见 [开发与架构设计](../guide/ARCHITECTURE.md) · [前端实现状态](../../FRONTEND_STATUS.md)

## 1. 当前前端架构与目录职责

GroupProof 前端已完成全量真实后端接线并上线至 Staging、Production 与 Admin Console，技术栈为 **Next.js 15 App Router、React 19、TypeScript、Tailwind CSS v4、Radix UI / shadcn 风格组件、Lucian UI 动效底座、TanStack Query、next-intl（简 / 繁 / 英三语）**。

- **`app/`**：App Router 入口（`app/[[...slug]]/page.tsx` 服务端鉴权门禁）、全局样式（`app/globals.css`）、`/api/v1/*` 同源运行时代理、`/api/locale`、`/api/admin-environment` 与 `/healthz`。
- **`student/`**：学生工作台（课程、独立/课程项目、需求基线、计划、任务三视图、证据中心、GitHub/飞书协作、验收、贡献分析 v2、7 章节报告与导出）。
- **`teacher/`**：教师 5-Hub 工作台（`.gp-teacher-shell` 独立作用域，将课程治理整合为 **概览 / 组队与名单 / 审批与申诉 / 项目与报告 / 课程设置** 5 大中心，内置 `Cmd/Ctrl+K` 快速跳转与花名册抽屉，兼容全部历史路由）。
- **`admin/`**：管理员治理控制台（`.gp-shell-admin` 独立作用域，含 Staging / Production 环境切换器、用户目录、教师审核、课程治理、审计日志、OpenRouter AI 用量看板与异常访问审批）。
- **`shared/`**：跨角色共享壳层（`shared/components/workspace-shell.tsx`）、路由分发器、基础控件（`shared/components/ui/`）、Lucian UI 组件与样式（`shared/auth/lux/`、`shared/components/lux/`、`shared/styles/lux-*.css`）、认证与账户中心（`shared/auth/`）、首页/动态/通知收件箱（`shared/daily-inbox/`）、三语目录（`shared/i18n/`）、路由解析与 API 客户端（`shared/lib/routes.ts`、`shared/lib/api-client.ts`）以及仅用于隔离测试的 `shared/legacy-mock/`（线上强制关闭）。

## 2. 核心业务与交互契约

- 所有业务请求经 `/api/v1/*` 同源代理直连 `services/api`（HttpOnly Session Cookie + CSRF + 服务端 Contextual RBAC），不再使用 `localStorage` 演示鉴权或前端 Mock 数据源。
- 领域实体通过真实 PostgreSQL UUID 贯通 `Course → Group → Project → Requirement → FunctionalModule → Task/Subtask → AcceptanceCriterion → Evidence → Verification → Contribution v2 → Report`。
- 保留核心业务不变量：任务树/看板/列表共享同一份 Task 数据；进度 100% 不自动提交；AI 验收通过仍需人工确认；正式证据按规则撤回或作废并在同事务失效关联验收。
- 路由解析与门禁分类统一维护在 `shared/lib/routes.ts`（`resolveRoute` / `classifyPath`），并由 `scripts/check-routes.mjs` 在本地与 CI 中自动核验。

## 56 页路由映射

> **脚本解析约束**：下表 01–56 行由 `scripts/check-routes.mjs` 解析校验（校验全部 56 个核心设计页的路由映射与匿名重定向鉴权语义），请勿更改表格列结构或增删两位编号行。  
> **视图与兼容说明**：任务树/看板/列表在导航中合并为单一“任务”入口（默认 `?view=tree`），11–13 历史查询参数保持有效；02/03 的 `/onboarding/*` 为兼容别名，经门禁重定向至 `/account/profile` 与 `/account/email`；表中 `project-1` / `course-1` / `group-1` / `task-1` / `milestone-1` / `member-1` 为路由模式占位符，线上全部使用真实 UUID。

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
| 29 | 项目设置（含 GitHub 仓库、飞书群聊集成与移入课程） | `/projects/project-1/settings` |
| 30 | 个人动态 / 我的记录 | `/activity` |
| 31 | 我的课程（真实分页列表；`?intent=create-project` 选择课程） | `/courses` |
| 32 | 加入课程（真实邀请码预览、确认加入或申请审批） | `/courses/join` |
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

## 3. 扩展工作台页面（57–63）与别名入口

在原 56 个设计页之外，按 `shared/lib/routes.ts` 扩展了以下业务工作台与入口路由（其中 `/admin` 与 `/projects` 由 `scripts/check-routes.mjs` 单独显式断言）：

| 页面名称 | 前端路由 | 运行编号 | 说明 |
| --- | --- | --- | --- |
| 教师课程列表 | `/teacher/courses` | `screen=57` | 教师名下全部课程与班级入口 |
| 教师跨班仪表盘 | `/teacher/dashboard` | `screen=58` | 跨课程总体进度、风险与待审批聚合总览 |
| 教师教学团队与助教授权 | `/teacher/courses/:courseId/staff` | `screen=59` | 课程助教关联与细粒度操作权限配置 |
| 教师课程公告 | `/teacher/courses/:courseId/announcements` | `screen=60` | 课程公告发布与阅读回执 |
| 教师班级项目总览 | `/teacher/courses/:courseId/projects` | `screen=61` | 班级内全部小组项目与移入课程项目一览 |
| Admin 工作台总览 | `/admin` | `screen=62` | 管理端运营首页与 Staging / Production 双环境切换 |
| 学生我的项目 | `/projects` | `screen=63` | 分离展示独立项目与课程项目，支持新建独立项目与一键移入课程 |
| 新建独立项目 | `/projects/new` | `screen=35`（独立模式） | 无需绑定课程或小组即可直接立项，后续可移入课程 |
| 学生课程资料只读页 | `/courses/:courseId/files` | `screen=50`（学生只读） | 按文件夹/版本浏览与下载教师发布的课程资料 |

## 4. 账户与系统页

| 页面 | 路由 | 门禁 | 说明 |
| --- | --- | --- | --- |
| 个人中心入口 | `/account` | 有会话 | 跳转本人当前待办步骤；已激活默认进入资料页 |
| 个人中心基本资料 | `/account/profile` | 有会话且未停用 | 姓名、身份、学号（学生）、学院与真实学校邮箱验证状态；白名单 + `expectedVersion` |
| 学校邮箱绑定/验证/更换 | `/account/email` | 有会话且未停用 | `@student.must.edu.mo` / `@must.edu.mo` 验证码发信、校验与独立换绑流程 |
| 身份确认（学生/教师） | `/account/status` | 有会话 | 展示入台资格摘要与教师入驻审核进度 |
| 账号安全 | `/account/security` | 有会话 | 修改密码、Google OIDC 账号关联/解除、个人 GitHub OAuth 身份绑定/解绑 |
| 注册资料页 | `/register/profile?tx=<id>` | 有效已验证事务 + 同浏览器 Cookie | 带入已验证学校邮箱，填写身份资料与密码完成建档 |
| 密码重置 | `/reset-password` | 公开 | 邮件链接 fragment 令牌在页面即刻清除后经 `POST` 提交 |
| 旧资料/邮箱验证别名 | `/onboarding/profile`、`/onboarding/email-verification` | 同门禁 | 兼容重定向至 `/account/profile` 与 `/account/email` |
| 旧外部绑定入口别名 | `/github/<项目 UUID>`、`/feishu/<项目 UUID>` | 同项目门禁 | 重定向至项目设置页对应集成面板 |
| 公共接口路由 | `POST /api/locale`、`GET /healthz` | 公开 | 写入白名单 `gp_locale` Cookie；容器健康检查 |
| 未知路由 | — | — | 返回 404，不加载业务工作区 |

认证与业务 API 统一经 `/api/v1/*` 访问 `services/api`，完整接口契约以 [packages/domain/openapi.json](../../packages/domain/openapi.json) 为唯一权威定义。

## 5. 视觉体系与交互升级记录

### 2026-11-22 学生端统一画布与 GitHub AI 摘要

- 共享令牌与基础组件位于 `app/globals.css`、`shared/components/common.tsx` 与 `shared/components/workspace-shell.tsx`，设计规格见 [学生端统一 UI 设计与实现规格](../superpowers/specs/2026-11-22-student-ui-unified-design.md)。
- `/projects/:projectId/github` 首屏展示提交者与 AI 实现摘要（后端 `services/api/app/modules/a/activity_summary.py` 与 `a_activity_summaries` 迁移 `0047`），详情抽屉按需展示文件差异、证据引用与原始来源。

### 2026-11-25 Lucian UI 视觉与动效改版（已合入 `develop` 与 `main` 上线）

- 新增 `shared/styles/lux-tokens.css`、`lux-shell.css`、`lux-student.css`、`lux-teacher.css` 与 `shared/components/lux/`、`shared/auth/lux/`。
- 落地登录页粒子词标（`ParticleWordmark`）、浮动输入框（`FloatingField`）、三语旋转选择器（`LanguagePicker`）、教师 5-Hub 悬浮变形导航（`MorphNav`）、首页弹性快捷行（`JellyActionRow`）、侧栏平滑折叠与可搜索下拉框，全部支持 `prefers-reduced-motion: reduce` 静态降级，Playwright UX 自检 24/24 通过（详见 [UI 改版自检报告](../testing/2026-11-25-ui-redesign-selfcheck.md)）。
