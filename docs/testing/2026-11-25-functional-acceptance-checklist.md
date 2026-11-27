# GroupProof 功能验收检查清单（2026-11-25）

> **历史归档文档**：本文记录对应阶段的规划/验收快照，不代表当前最新状态；当前架构、实时交付状态与限制请以 [README.md](../../README.md) 与 [FRONTEND_STATUS.md](../../FRONTEND_STATUS.md) 为准。

> **适用环境**：`/Users/motasy_delay/GroupProof-team/groupproof-final`（前端 `http://localhost:3000`，后端 `http://localhost:8000`，Alembic 迁移头 `0047`）。  
> **参考依据**：[前端实施计划（56 页 + 62/63 路由映射）](../architecture/FRONTEND_IMPLEMENTATION_PLAN.md)、[前端交付状态](../../FRONTEND_STATUS.md)、`shared/lib/routes.ts`、`shared/components/route-dispatcher.tsx`、`shared/components/workspace-shell.tsx`、`teacher/components/TeacherClassLayout.tsx` 与各业务目录实际页面。

---

## 0. 当前环境状态、自动检查与边界总览

### 0.1 工程基线自动检查（2026-11-25 实跑全绿）

| 检查项 | 命令 | 结果 | 关键输出 |
|---|---|---|---|
| ESLint | `npm run lint` | 通过（exit 0） | 无报错 |
| TypeScript | `npm run typecheck` | 通过（exit 0） | 无类型错误 |
| 三语词条一致性 | `npm run check:i18n` | 通过（exit 0） | `zh-Hans` / `zh-Hant` / `en` 共 **912** 个键一致，参数与复数结构核对通过 |
| 路由与匿名鉴权门禁 | `CHECK_HTTP=1 npm run check:routes` | 通过（exit 0） | 核对 **56** 个设计页 + `/projects`（63）+ `/admin`（62）入口；`/login` 返回 200，`/onboarding/*` 跳转 `/account/*`，其余业务路由匿名重定向 `/login` |

### 0.2 本地 `.env` 实配与 Real vs. Mock 边界

> 下列配置仅记录非敏感键名与启用状态，不包含任何凭据或密钥值。

| 维度 | 当前 `.env` / 运行状态 | 对验收的实际影响与前置条件 |
|---|---|---|
| 前端模式开关 | `NEXT_PUBLIC_APP_MODE=real`，`NEXT_PUBLIC_ENABLE_MOCKS=false`，`NEXT_PUBLIC_API_FEATURES=`（空） | 全站所有功能模块 `apiMode(...) === "real"`，走 `/api/v1/*` 同源代理对接 FastAPI；不加载 `shared/legacy-mock/` 演示数据或角色切换器。 |
| 后端运行模式与库状态 | `APP_MODE=dev`，`APP_ORIGIN=http://localhost:3000`，全新 PostgreSQL 库（`alembic_version=0047`，157 张表） | 初始库无任何用户、课程与项目。须先用 `docker compose exec -T api python -m scripts.bootstrap_admin ...` 开通初始管理员，再创建或注册学生/教师账号。 |
| 密码与会话能力 | `AUTH_PASSWORD_ENABLED=true`，`/api/v1/auth/capabilities` 返回 `password.available=true` | 用户名/邮箱 + 密码登录、`POST /api/v1/auth/session/refresh`、改密与登出完全可用（真实 PostgreSQL + Argon2id/bcrypt + Cookie/CSRF）。 |
| Google OIDC | `AUTH_GOOGLE_ENABLED=true`，但 `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` 为空 → `google.available=false` | `/login` 自动隐藏 Google 登录按钮；`/account/security` 中绑定 Google 会返回不可用，直到在 `.env` 配置 Google OAuth 凭据并重启 `api`。 |
| 邮件与验证码 | `MAIL_MODE=resend`、`MAIL_PUBLIC_ENABLED=false`、`RESEND_API_KEY` 为空 → `emailSignup` / `passwordReset` / `schoolEmailVerification` 均 `available=false` | 自助邮箱注册发码、忘记密码发码、学校邮箱验证发码在当前 `.env` 下会不可用。本地联调邮箱流程需在 `.env` 改用 `MAIL_MODE=capture`（验证码写入 `email_outbox` 表）或配置真实邮件凭据；另 `ACCEPTANCE_TEST_TOKEN` 未配置（`acceptanceTest.enabled=false`）。 |
| 对象存储（Supabase） | `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` / `SUPABASE_STORAGE_BUCKET` 均为空 | 预签名上传 `POST /api/v1/storage/uploads` 不可用；前端 `FileUploadForm` / `sendFileDirect` 与项目初始化资料会自动走服务端内联/直传回退（`POST /api/v1/storage/uploads/direct` 及 `POST /api/v1/projects/{id}/materials/upload-inline`），仍执行真实 SHA-256 与文件内容校验。 |
| GitHub / 飞书集成 | `GITHUB_APP_*` / `GITHUB_OAUTH_*` / `FEISHU_APP_*` 均为空 | 项目设置中的 GitHub 仓库绑定/同步、飞书群聊机器人校验/同步、个人中心 GitHub/飞书授权绑定会返回不可用/配置缺失提示；UI 错误边界与只读状态可测，真实外部数据需配置对应凭据后验收。 |
| AI 提供方 | `.env` 中 `AI_PROVIDER=` 为空，`docker-compose.yml` 回退为 `AI_PROVIDER=fake` | 需求提取、任务建议、GitHub 活动摘要（`0047`）、AI 验收检查、风险解释与报告章节 AI 重写均使用后端确定性 `fake` 提供方，而非真实 LLM（需配置 `AI_PROVIDER=openrouter` 与 `AI_API_KEY`/`OPENROUTER_API_KEY` 后切换真实模型）。 |
| 异步 Worker / 定时任务 | `dev-backend.sh` 仅启动 `postgres`、`redis`、`api`；`report-worker` 与 `risk-scheduler` 未启动 | `APP_MODE=dev` 下结项报告预览与 PDF/DOCX 导出会自动走 FastAPI 进程内同步/后台线程回退；每日定时风险批处理需手动 `docker compose up -d risk-scheduler` 或触发单项目计算。 |
| Admin 双环境切换 | `ADMIN_API_DEVELOP_URL` / `ADMIN_API_MAIN_URL` 未配置 | `/admin` 顶栏切换 `develop` / `main` 会写 `gp_admin_environment` Cookie 并退回 `/login`，当前两个环境均代理回本地 `http://localhost:8000`。 |

---

## 1. Account & Auth（账号、认证与注册闭环）

| ID | 检查项 | 路由 / 页面编号 | UI 入口 | 人工验收步骤 | 预期结果 | Real vs. Mock / `.env` 边界 |
|---|---|---|---|---|---|---|
| AUTH-01 | 匿名路由门禁与兼容别名 | `/home`、`/projects`、`/admin`、`/onboarding/profile`、`/onboarding/email-verification`、`/unknown-xyz` | 浏览器地址栏直接访问 | 1. 在无痕窗口依次访问 `/home`、`/projects`、`/admin`。<br>2. 访问 `/onboarding/profile` 与 `/onboarding/email-verification`。<br>3. 访问不存在路径 `/unknown-xyz`。 | 1. 业务页均 307 重定向至 `/login?returnTo=...`，且不挂载业务工作区。<br>2. 旧 `/onboarding/*` 先跳 `/account/profile` 或 `/account/email` 再由守卫跳 `/login`。<br>3. 未知路径返回 404 页面。 | **Real**（`app/[[...slug]]/page.tsx` 服务端守卫 + `shared/lib/routes.ts`）。 |
| AUTH-02 | 登录页能力感知与错误回显 | `/login`（01） | 首屏默认登录页 | 1. 打开 `/login` 检查可见登录方式与规则卡片。<br>2. 尝试提交空/错误密码，观察错误提示与 `requestId`。<br>3. 连续多次输错密码触发限流。<br>4. 测试 `/login?error=cancelled` 与 `/login?error=account_exists`。 | 1. 密码登录窗可见；因 `GOOGLE_CLIENT_ID` 为空，Google 按钮自动隐藏。<br>2. 错误提示含错误原因与 `requestId`。<br>3. 触发 `RATE_LIMITED` 时按钮按服务端 `retryAfter` 倒计时禁用，到期恢复。<br>4. URL 错误横幅正确显示，发起新登录动作时自动清除。 | **Real**（`/api/v1/auth/capabilities` + `/api/v1/auth/password/login`）；Google 按钮受 `.env` 中 `GOOGLE_*` 控制。 |
| AUTH-03 | 初始管理员 CLI 开通与密码登录 | `/login`（01） → `/admin`（62） | 服务端 CLI + `/login` 表单 | 1. 执行 `docker compose exec -T api python -m scripts.bootstrap_admin --name "系统管理员" --username admin --school-email admin@must.edu.mo --password "<强密码>"`。<br>2. 在 `/login` 用管理员用户名或邮箱与密码登录。 | 1. CLI 幂等返回管理员账号 JSON。<br>2. 登录后直接进入 `/admin` 管理总览（`app/[[...slug]]/page.tsx` 对管理员从 `/home` 重定向到 `/admin`）。 | **Real**（PostgreSQL `users` + `auth_identities` + `bootstrap_admin.py`）。 |
| AUTH-04 | 邮箱注册弹窗与注册资料页 | `/login` 弹窗 → `/register/profile?tx=<id>` | `/login` 页「立即注册」按钮 | 1. 点击「立即注册」输入学校邮箱（学生 `@student.must.edu.mo` / 教师 `@must.edu.mo`）发送验证码。<br>2. 填验证码校验后跳转 `/register/profile?tx=<id>`。<br>3. 切换身份（学生/教师），核对学号显隐，填写姓名、密码（>=8 位）与确认密码提交。 | 1. 发码受同浏览器事务 Cookie 与 60s 重发冷却约束；`tx` 校验通过后进入资料页。<br>2. 学生完成后直接授予学生角色并进 `/home`；教师提交后进入 `/account/status` 等待管理员审核。 | **受 `.env` 限制**：当前 `MAIL_MODE=resend` 且 `RESEND_API_KEY` 为空会返回不可用；改为 `MAIL_MODE=capture` 可从 `email_outbox` 表取验证码完成全流程。 |
| AUTH-05 | 忘记密码与重置密码 | `/login` 弹窗 → `/reset-password`（99） | `/login` 页「忘记密码」链接 | 1. 点击「忘记密码」输入已验证登录邮箱并提交。<br>2. 打开重置链接 `/reset-password#token=...`。<br>3. 输入新密码（>=8 位）并提交，用新密码重登（旧会话应失效）。 | 1. 请求返回统一安全提示（不泄露账号是否存在）。<br>2. 页面读取 fragment 令牌后立即从地址栏清除；重置成功后撤销旧会话与重置令牌。 | **受 `.env` 限制**：依赖 `MAIL_MODE=capture` 或真实邮件配置。 |
| AUTH-06 | 个人中心资料、学校邮箱与身份状态 | `/account`（100）、`/account/profile`（101）、`/account/email`（102）、`/account/status`（103） | 顶栏头像菜单 →「个人中心」 | 1. 进入 `/account/profile` 修改姓名/学院/学号（学生），验证并发 `expectedVersion` 提示与保存。<br>2. 进入 `/account/email` 查看已验证状态或发起学校邮箱换绑。<br>3. 进入 `/account/status` 查看三项注册/审核进度、`ProgressStatusChip` 与「登入」/「返回首页」按钮。<br>4. 对未激活教师账号测试直接访问 `/home` 与在 `/account/status` 提交/刷新审核状态。 | 1. 受限账号仅显示 `AccountShell` 四步进度，不挂载工作区导航/搜索/通知；全部必填项完成后可点击「登入」调用 `session/refresh` 轮换 Cookie/CSRF 并进入 `/home`。<br>2. 教师未通过审核前访问 `/home` 被强制拦回 `/account/status`。 | **Real**（`/api/v1/me`、`/api/v1/auth/session/refresh`）；邮箱换绑验证码发送受 `MAIL_MODE` 控制。 |
| AUTH-07 | 账号安全：登录邮箱补验、改密与第三方关联 | `/account/security`（104） | 个人中心顶部导航「账号安全」（可选） | 1. 修改当前登录密码并确认会话平滑保持。<br>2. 若登录邮箱未验证，测试发码补验。<br>3. 查看右栏第三方关联区（Google / GitHub / 飞书）：测试未配置凭据时的降级提示或发起授权；仅用已激活账号访问 `MyAccessRequests`（位于 `/account/profile` 右栏）。 | 1. 密码修改成功提示且旧密码失效；已设置密码才允许解绑 Google。<br>2. 在当前本地 `.env` 下，Google / GitHub / 飞书未配置凭据时明确提示不可用/未配置，不伪造成功。 | **混合边界**：改密/会话为 **Real**；Google/GitHub/飞书关联及登录邮箱发码依赖 `.env` 外部凭据。 |
| AUTH-08 | 三语切换与安全退出 | 全站顶栏 / `/account` 顶栏 + `POST /api/locale` | `LanguageSwitcher` 下拉框、头像菜单「退出登录」 | 1. 在 `/login`、`/account/profile`、`/home` 切换 `zh-Hans` / `zh-Hant` / `en`。<br>2. 刷新页面确认语言持久化。<br>3. 点击「退出登录」，再用浏览器后退键检查受保护页。 | 1. 语言切换即时生效，写 `gp_locale` Cookie 并保留当前页面与未保存输入；已登录同时更新账户偏好。<br>2. 退出调用服务端注销接口撤销会话、清理本地工作区缓存并跳转 `/login`；后退不可继续查看原业务数据。 | **Real**（`app/api/locale/route.ts` + `/api/v1/auth/logout`）。 |

---

## 2. Student Workbench（学生工作台）

### 2.1 全局日常入口、导航与全局搜索

| ID | 检查项 | 路由 / 页面编号 | UI 入口 | 人工验收步骤 | 预期结果 | Real vs. Mock / `.env` 边界 |
|---|---|---|---|---|---|---|
| STU-01 | 学生首页与跨项目摘要 | `/home`（04） | 登录后默认入口 / 顶栏「首页」 | 1. 用已激活学生账号登录进入 `/home`。<br>2. 检查我的项目摘要（最近项 + 独立/课程项目徽章 + GitHub/飞书接入状态）、我的课程与最近动态。<br>3. 点击公告横幅（如有）与「创建项目」「加入课程」快捷入口。 | 1. 零数据时展示明确引导而非伪造演示项目。<br>2. 若读取 GitHub/飞书接入数失败显示“状态暂不可用”，不会误报“未接入”。<br>3. 全域使用顶部水平导航（非项目内侧边栏）。 | **Real**（`HomeApiPage` 调 `/api/v1/daily/home`、`GET /api/v1/a/projects/{id}/github/repos` 等）；无数据时依赖先建课/建项。 |
| STU-02 | 我的项目总览与独立项目创建 | `/projects`（63）、`/projects/new`（35） | 顶栏「我的项目」/「新建项目」按钮 | 1. 打开 `/projects`，切换筛选 Tab（全部 / 独立项目 / 课程项目）与搜索框。<br>2. 点击创建独立项目进入 `/projects/new`（或模态框），填写名称与说明创建。<br>3. 对已有独立项目测试 `AttachCourseControl`（绑定到已加入课程）。 | 1. 独立项目无需先加入课程或组队即可创建并跳转 `/projects/:id`。<br>2. 课程项目与独立项目在列表中清晰区分，进度与生命周期真实读取后端。 | **Real**（`MyProjectsApiPage` + `IndependentProjectPage` + `bProjectsApi`）。 |
| STU-03 | 全局搜索、通知中心、待处理与个人动态 | `/notifications`（05）、`/action-items`（06）、`/activity`（30） | 顶栏搜索框、顶栏铃铛弹窗 `NotificationCenterPopover`、头像菜单「个人动态」 | 1. 在顶栏搜索框输入课程/项目/任务关键词，使用 `↑`/`↓`/`Enter`/`Esc` 键盘操作跳转。<br>2. 点击顶栏铃铛切换「待处理 / 通知」Tab，标记单条通知已读，再进入 `/notifications` 和 `/action-items` 验证筛选、分页与全部已读。<br>3. 打开 `/activity` 按平台/项目筛选个人活动。 | 1. 全局搜索调用 `GET /api/v1/search`，严格按当前用户权限过滤，不泄露无权项目内部任务/证据。<br>2. 通知已读携带 `expected_version` 与幂等键，顶栏未读红点同步刷新。 | **Real**（`search-client.ts`、`c-inbox-client.ts`、`DailyApiPages.tsx`）。 |

### 2.2 课程加入、组队、成员变更与课程规则

| ID | 检查项 | 路由 / 页面编号 | UI 入口 | 人工验收步骤 | 预期结果 | Real vs. Mock / `.env` 边界 |
|---|---|---|---|---|---|---|
| STU-04 | 我的课程与邀请码加入课程 | `/courses`（31）、`/courses/join`（32） | 顶栏「我的课程」→「加入课程」 | 1. 打开 `/courses` 切换全部 / 进行中 / 已结课 Tab 与搜索、分页。<br>2. 进入 `/courses/join` 输入教师提供的课程邀请码预览课程信息。<br>3. 根据课程 `join_mode` 执行直接加入或提交审批申请。 | 1. 仅展示本人已加入课程，分页与 URL 参数同步。<br>2. 邀请码预览准确显示课程规则、人数限制与截止时间；审批模式提交后生成待处理记录，待教师通过后出现在 `/courses`。 | **Real**（`CoursesApiPages.tsx` + `bCoursesApi`）。 |
| STU-05 | 课程内组队与小组管理 | `/courses/:courseId/groups`（33）、`/courses/:courseId/groups/:groupId`（34） | 课程卡片 →「课程内组队」/ 小组详情 | 1. 进入 `/courses/:courseId/groups` 查看组队广场与规则提示，创建新小组或加入已有小组。<br>2. 进入 `/courses/:courseId/groups/:groupId` 查看成员列表、申请列表，组长处理入组申请或调整成员状态。<br>3. 测试通过 `/courses?intent=create-project` 或小组页「创建课程项目」进入 `/courses/:courseId/projects/new`（35）。 | 1. 人数限制（`min_group_size`–`max_group_size`）与组队截止时间由后端校验；非组长隐藏/禁用审批动作。<br>2. 从小组创建的课程项目自动关联 `course_id` 与小组成员。 | **Real**（`GroupsApiPages.tsx` + `ProjectsApiPages.tsx`）。 |
| STU-06 | 转让组长、退组申请、规则变更、重开与课程文件 | `/courses/:courseId/groups/:groupId/change-leader`（36）、`.../leave`（37）、`/courses/:courseId/rule-changes`（38）、`/courses/:courseId/projects/reopen`（39）、`/courses/:courseId/rules`（40）、`/courses/:courseId/files`（50 学生入口） | 小组详情操作链接 / 课程卡片「课程规则」「课程资料」 | 1. 组长进入 `change-leader` 发起转让并由接收人确认。<br>2. 成员进入 `leave` 提交退组理由（触发教师审批流）。<br>3. 查看 `/courses/:courseId/rules`（只读课程已发布规则）与 `/courses/:courseId/rule-changes`（当教师变更课程规则时确认差异）。<br>4. 若课程项目需重开，在 `reopen` 提交重开申请。<br>5. 打开 `/courses/:courseId/files` 按文件夹/关键词筛选并下载教师发布的课程资料（含 `?version=` 历史版本直链）。 | 1. 所有变更写操作均带幂等键与权限检查，非授权成员收到明确权限提示。<br>2. 规则版本只读取最新已发布版本；课程资料按可见范围（全班/指定小组）过滤并支持分版本下载。 | **Real**（`MembershipApiPages.tsx`、`CourseRulesApiPage.tsx`、`CourseReopenApiPage.tsx`、`StudentCourseFilesApiPage.tsx`、`CourseFilesApiPage.tsx`）。 |

### 2.3 项目初始化、需求基线、任务与执行验收

| ID | 检查项 | 路由 / 页面编号 | UI 入口 | 人工验收步骤 | 预期结果 | Real vs. Mock / `.env` 边界 |
|---|---|---|---|---|---|---|
| STU-07 | 项目总览、项目切换与项目初始化中心 | `/projects/:projectId`（07）、`/projects/:projectId/setup`（08） | 我的项目列表 / 左侧边栏项目切换下拉 | 1. 进入项目总览 `/projects/:projectId`，检查侧栏分组导航（概览/规划/协作/复盘）、项目切换器与 `ProjectSetupCenter` 卡片状态。<br>2. 进入 `/setup` 补充项目简介/类型，上传项目初始化资料（`.pdf`/`.docx`/`.md`/`.txt`）并检查正文提取结果；尝试上传损坏或无文本层文件验证错误反馈。 | 1. 非本组成员访问课程公开项目时仅见总览摘要 `ProjectSummary`，内部任务/文件/证据不可见。<br>2. 即使 `.env` 未配 Supabase，资料上传自动走 `/materials/upload-inline` 完成文本分段提取与 SHA-256 校验。 | **混合边界**：项目 CRUD 与文档提取为 **Real**；GitHub/飞书状态卡在未配凭据时显示“暂不可用”。 |
| STU-08 | 需求整理、冲突处理与基线冻结 | `/projects/:projectId/requirements`（09） | 侧栏「规划 → 需求」 | 1. 从已上传资料触发 AI 需求提取，或手动新增需求条目与功能模块。<br>2. 如产生冲突（`?section=conflicts`），对比冲突版本并选择保留项。<br>3. 进入 `?section=baseline` 生成/更新草稿版本，组织团队成员逐一确认，组长点击冻结基线。 | 1. 基线草稿与正式冻结版本严格分离；冻结后记录固化精确课程规则与课程文件版本快照（`_snapshot`）。<br>2. 任一成员未确认或存在未解决冲突时阻止冻结或给出明确提示。 | **混合边界**：需求/模块/冲突/冻结状态机为 **Real**（PostgreSQL）；AI 自动提取当前跑 `AI_PROVIDER=fake` 固定输出。 |
| STU-09 | 任务规划与三视图切换（树/看板/列表） | `/projects/:projectId/planning`（10）、`/projects/:projectId/tasks?view=tree\|board\|list`（11/12/13） | 侧栏「规划 → 任务」/ 视图切换器 | 1. 进入 `/planning` 发起 AI 任务规划建议或手动拆解父子任务、分配负责人与权重。<br>2. 在 `/tasks` 依次切换 `?view=tree`（11）、`?view=board`（12）、`?view=list`（13），创建一个任务或变更状态。<br>3. 核对三视图是否同步反映同一批 Task 数据。 | 1. 三视图共用同一后端任务集，状态与负责人变更跨视图即时一致。<br>2. `/planning` 与 `/tasks?view=plan` 均正确高亮侧栏「任务」入口。 | **混合边界**：任务树/看板/列表持久化为 **Real**；AI 任务建议为 `AI_PROVIDER=fake`。 |
| STU-10 | 任务详情、提交、证据完整性与 AI/人工验收 | `/projects/:projectId/tasks/:taskId`（14）、`.../submit`（15）、`.../evidence-check`（16）、`.../verification`（17） | 任务列表点击任务 → Tab / 跳转按钮 | 1. 打开任务详情（14），填写进度（含 100% 与进度原因）、版本化任务说明并保存。<br>2. 进入提交页（15）关联候选证据或链接并提交待验收。<br>3. 进入证据完整性检查（16）核对各验收标准覆盖状态。<br>4. 进入验收页（17）运行 AI 逐项检查，再由负责人执行人工确认「通过/不通过」。<br>5. 返回（15）或证据中心修改/作废一条已绑定正式证据，回到（14/17）验证旧验收是否作废。 | 1. 进度调至 100% **不会**自动提交或直接标为已验收。<br>2. AI 验收通过仍标记为待人工确认；只有人工确认后才算数。<br>3. 正式证据变更/作废会在原事务中联动使 D 模块既有验收结果失效并显示失效原因。 | **混合边界**：任务/提交/证据/D 人工验收与失效事务为 **Real**；AI 逐项核验当前使用 `AI_PROVIDER=fake`。 |
| STU-11 | 里程碑、项目风险、证据中心与项目文件 | `/projects/:projectId/milestones`（18）、`.../milestones/:milestoneId`（19）、`/evidence`（20）、`/files`（23） | 侧栏「规划 → 里程碑」「复盘 → 证据」「协作 → 文件」 | 1. 查看 `/milestones` 与嵌入式风险面板（`RiskApiPage`），进入里程碑详情（19）核对关联任务与提交状态。<br>2. 在 `/evidence` 按类型/状态/任务筛选证据，测试正式证据撤回/作废与抽屉详情。<br>3. 在 `/files` 上传新文件（`FileUploadForm`）、追加新版本（测试版本锁冲突刷新）并在线预览（PDF/图片/Markdown/文本）与下载。 | 1. 即使未配 Supabase，`/files` 上传会自动回退 `POST /api/v1/storage/uploads/direct`，完成字节传输与浏览器端 SHA-256 核对后登记。<br>2. `Escape` 关闭详情抽屉，URL 筛选刷新保持一致。 | **Real**（PostgreSQL + 直接字节上传校验）；未配置外部 Supabase 时自动走直传存储。 |
| STU-12 | GitHub 活动与 AI 摘要、飞书协作记录、讨论区 | `/projects/:projectId/github`（21）、`/collaboration`（22）、`/discussions`（24） | 侧栏「协作 → GitHub / 协作记录 / 讨论区」 | 1. 打开 `/github` 查看提交者 + 实现摘要列表、统计图表，点击某条打开详情抽屉查看文件差异/证据引用/操作历史，触发单条或批量生成 AI 摘要。<br>2. 打开 `/collaboration` 查看飞书群聊同步记录与脱敏长文本详情。<br>3. 打开 `/discussions` 创建话题、回复并 @ 提及成员或关联任务/证据。 | 1. `/github` 抽屉中 AI 摘要明确标注「AI 已生成 · 待人工确认」，不直接写入正式任务状态；PR/CI 仅作来源证据。<br>2. 讨论区支持预览态与详细讨论（`?discussion=`）且按项目成员权限管控。 | **混合边界**：讨论区与 `0047` 摘要缓存库表为 **Real**；GitHub/飞书未配 `.env` 凭据时无真实外部拉取数据，摘要生成走 `AI_PROVIDER=fake`。 |
| STU-13 | 贡献总览、成员贡献详情、报告预览/导出与项目设置 | `/projects/:projectId/contribution`（25）、`.../contribution/:memberId`（26）、`/reports`（27）、`/reports/export`（28）、`/settings`（29）、`/github/:projectId`、`/feishu/:projectId` | 侧栏「复盘 → 贡献」「项目设置」/ 报告入口 | 1. 在 `/contribution` 查看成员贡献与图表，点进 `/contribution/:memberId` 核对个人证据明细；组长点击「确认并冻结贡献快照」。<br>2. 进入 `/reports` 生成结项报告预览，测试章节编辑、AI 重写单章、版本切换、提交给教师审核。<br>3. 进入 `/reports/export` 分别导出并下载 **DOCX**、**PDF** 与 **Markdown**，核对中文标题/统计表/证据附录是否完整。<br>4. 进入 `/settings` 测试仓库/群聊绑定区（及旧入口 `/github/:id`、`/feishu/:id` 锚点跳转）与归档项目（归档后检查全项目只读锁定）。 | 1. 贡献快照冻结后方可将确定快照写入新报告；旧报告仍锁定原快照。<br>2. 当前未起 `report-worker`，但因 `APP_MODE=dev`，预览与 DOCX/PDF 导出走 API 进程内回退可直接生成并下载。<br>3. 项目归档后页面 14–29 写操作全部置只读。 | **混合边界**：贡献冻结/报告导出/归档为 **Real**；AI 重写走 `fake`；GitHub/飞书绑定受 `.env` 凭据限制。 |

---

## 3. Teacher 5-Hub Workbench（教师工作台）

| ID | 检查项 | 路由 / 页面编号 | UI 入口 | 人工验收步骤 | 预期结果 | Real vs. Mock / `.env` 边界 |
|---|---|---|---|---|---|---|
| TCH-01 | 教师全局工作台、班级列表与创建班级 | `/teacher/dashboard`（58）、`/teacher/courses`（57） | 左侧边栏「教师工作台」「我的班级」 | 1. 用已审核通过的教师账号登录，进入 `/teacher/dashboard` 核对跨班级聚合指标（待处理事项、管理班级、在研项目、风险队伍）。<br>2. 进入 `/teacher/courses` 切换状态 Tab（进行中/已结课/全部）与搜索，点击「创建班级」抽屉填写名称/学期/人数上限/截止时间/加入方式并提交。<br>3. 复制新班级的邀请码。 | 1. 页面自动应用 `gp-teacher-shell` 主题作用域，左侧导航栏可折叠并记忆到 `gp:teacher-rail-collapsed`。<br>2. 创建班级成功后即时显示班级详情与真实邀请码，刷新列表保留。 | **Real**（`teacherDashboardApi` + `teacherClassesApi`）。 |
| TCH-02 | `⌘K` 快速跳转、班级切换器与可折叠花名册 | 任意 `/teacher/courses/:courseId/*` | 顶栏「搜索班级、模块或学生... (⌘K)」、班级顶部班级下拉、右上「花名册」按钮 | 1. 在教师页面按 `Cmd/Ctrl+K` 打开 `TeacherQuickSwitcher`，输入班级名或学生名跳转。<br>2. 在 sticky 顶栏测试切换班级下拉、点击邀请码胶囊弹窗轮换邀请码。<br>3. 点击「花名册」按钮展开右侧花名册（xl 桌面侧栏 / 窄屏 Sheet），点击某位学生打开 `StudentProfileDrawer`（可移除学生并填写原因）。 | 1. `⌘K` 在输入框聚焦时不误触发，按 `Esc` 关闭。<br>2. 邀请码轮换带 `lock_version`，成功后旧码失效。<br>3. 5 个 Hub 标签与「更多 (`...`)」菜单可准确到达全部 13 个班级子视图。 | **Real**（`TeacherClassLayout` + `TeacherQuickSwitcher` + `ClassRosterSidebar`）。 |
| TCH-03 | Hub 1：班级概览 | `/teacher/courses/:courseId`（41） | Hub 标签「概览」 | 1. 检查班级统计卡片（总学生/已分组/有项目小组/需关注风险组/平均进度）。<br>2. 点击高风险/预警预览小组直达小组详情。 | 人数要求、组队截止时间与各小组进度口径与数据库真实一致；零小组时显示明确空状态。 | **Real**（`TeacherClassHomeApiPage`）。 |
| TCH-04 | Hub 2：组队与名单（小组广场与小组详情） | `/teacher/courses/:courseId/groups`（42）、`/teacher/courses/:courseId/groups/:groupId`（43） | Hub 标签「组队与名单」→ 点击任意小组 | 1. 在 `/groups` 查看全部小组卡片、未分组学生与进度条。<br>2. 进入 `/groups/:groupId` 查看小组成员、关联项目概况、任务/里程碑进度与成员贡献，测试从详情操作或进入审批。 | 1. 窄屏下表格/卡片无横向溢出。<br>2. 数据与学生端课程内小组（33/34）同源一致。 | **Real**（`TeamPlazaApiPage` + `TeacherGroupDetailApiPage`）。 |
| TCH-05 | Hub 3：审批与申诉（待办中心、成员变动、申诉裁决） | `/teacher/courses/:courseId/actions`（44）、`.../member-changes`（48）、`.../appeals`（49） | Hub 标签「审批与申诉」/ 更多菜单「待办审批 / 成员变动 / 申诉裁决」 | 1. 在 `/actions` 筛选入课/入组/重开/结项报告审批项并执行通过/退回，核对徽章待办数同步减少。<br>2. 在 `/member-changes` 审批学生退组/换组申请。<br>3. 在 `/appeals` 查看学生提交的贡献或评审申诉，填写裁决意见与原因并提交。 | 1. 审批/裁决需要明确操作理由，成功后更新状态与审计历史；助教仅在获得对应授权后可执行写操作，否则按钮受限或提示无权。<br>2. 待办数量与课程顶栏红色角标同步刷新。 | **Real**（`TeacherActionsApiPage`、`MemberChangesApiPage`、`TeacherAppealsApiPage`）。 |
| TCH-06 | Hub 4：项目与报告（项目监控与班级报告汇总） | `/teacher/courses/:courseId/projects`（61）、`.../reports`（45） | Hub 标签「项目与报告」/ 更多菜单「项目监控 / 班级数据报告」 | 1. 在 `/projects` 查看全班小组项目的风险矩阵、里程碑时间线与活跃排行图表，点入具体项目或打开报告审核。<br>2. 在 `/reports` 查看各组提交的结项报告状态，对已提交报告执行「审核定稿」或「退回修改」（附理由）。 | 1. 教师可查看本班项目概览与报告；定稿/退回操作联动学生端 `/projects/:id/reports` 状态变为 `finalized` 或 `returned`。<br>2. 仅课程任课教师可定稿/退回，防止越权操作。 | **Real**（`TeacherProjectsApiPage`、`TeacherReportsApiPage`）。 |
| TCH-07 | Hub 5：课程设置（设置、规则模板、资料、公告、助教权限） | `/teacher/courses/:courseId/settings`（46）、`.../rules`（47）、`.../files`（50）、`.../announcements`（60）、`.../staff`（59） | Hub 标签「课程设置」/ 更多菜单「基础设置 / 规则与模板 / 课程资料 / 课程公告 / 助教管理」 | 1. 在 `/settings` 修改课程名称/截止时间/分组限制或结课归档课程。<br>2. 在 `/rules` 编辑规则草稿（必交材料、GitHub 必接要求、里程碑模板）并点击「发布规则版本」，在学生端验证新版本与规则变更提示。<br>3. 在 `/files` 上传课程资料、建文件夹、发布版本，验证学生端 `/courses/:id/files` 同步可见。<br>4. 在 `/announcements` 发布课程公告，验证学生端 `AnnouncementBanner` 弹出显示。<br>5. 在 `/staff`（仅课程主讲教师可见）添加助教并按粒度勾选权限，用助教账号登录验证默认只读与按授权开放边界。 | 1. 规则草稿与已发布版本分离；发布规则时同步写入 `course_rule_versions` 供学生立项与基线绑定。<br>2. 助教未获授权的操作严格受控，且「助教管理」入口仅主讲教师可见（`perms.isOwner`）。<br>3. 文件上传未配 Supabase 时自动走直传校验回退。 | **Real**（`TeacherSettingsApiPage`、`TeacherRulesApiPage`、`TeacherFilesApiPage`、`TeacherAnnouncementsApiPage`、`TeacherStaffApiPage` + `use-teacher-permissions.ts`）。 |

---

## 4. Admin Console（管理员治理工作台）

| ID | 检查项 | 路由 / 页面编号 | UI 入口 | 人工验收步骤 | 预期结果 | Real vs. Mock / `.env` 边界 |
|---|---|---|---|---|---|---|
| ADM-01 | Admin 工作台总览与权限隔离 | `/admin`（62） | 管理员登录后默认入口 / 左侧边栏「管理总览」 | 1. 用管理员账号登录，进入 `/admin` 核对四大指标（用户总数、待审核教师、课程总数、待审批访问）、账号结构与课程状态分布、最近账号列表与 4 个数据连接状态指示灯。<br>2. 测试用非管理员账号（学生/教师）访问 `/admin*`。<br>3. 测试在顶栏搜索框检索用户/课程。 | 1. 数据连接状态均显示「已连接」；若库内仅管理员 1 人显示引导提示。<br>2. 非管理员访问返回 403 / 无权限提示。<br>3. 管理员全局搜索仅返回课程与用户治理目录，绝不泄露任何项目内部任务/证据/文件。 | **Real**（`AdminDashboardPage` + `/api/v1/admin/*` + `/api/v1/c-admin/*`）。 |
| ADM-02 | 双环境切换器 | 任意 `/admin/*` 顶栏 | `AdminEnvironmentSwitcher` 下拉框 | 1. 在 `/admin` 顶栏切换 `develop` ↔ `main` 环境。<br>2. 检查响应 Cookie `gp_admin_environment` 与登录跳转。 | 1. 先尝试注销当前会话，POST `/api/admin-environment` 写 Cookie 后跳回 `/login` 要求针对目标环境重新认证。 | **受 `.env` 限制**：当前 `ADMIN_API_DEVELOP_URL` / `ADMIN_API_MAIN_URL` 未设置，两个环境均代理回本地 `http://localhost:8000`；设置两个不同后端 URL 后实现真实跨环境切换。 |
| ADM-03 | 用户目录、新建账号、停用与恢复 | `/admin/users`（51） | 侧栏「平台管理 → 用户管理」 | 1. 点击「新增账号」创建 1 名学生与 1 名教师，检查表单字段校验与唯一性冲突（409）。<br>2. 使用搜索、学院、角色、状态筛选与快捷状态筛选芯片，检查 URL 参数同步与摘要卡片统计。<br>3. 点击任意用户「查看」打开右侧抽屉，填写处理原因执行「确认停用」，再用该账号登录或刷新会话；随后执行「确认恢复」。<br>4. 模拟并发修改（两窗口打开同一用户先后提交），验证 409 版本冲突提示保留已填理由。 | 1. 停用后该账号立即无法访问业务页（`/me` 仅返回最少状态并被强制退至受限/停用提示），且停用原因写入该用户站内收件箱；恢复后可重登。<br>2. 不可自我停用或停用受保护账号时明确禁用操作。 | **Real**（`IdentityAdminApiPages.tsx` + `cIdentityClient`）。 |
| ADM-04 | 教师身份审核与历史记录 | `/admin/teacher-verifications`（52） | 侧栏「平台管理 → 教师审核」 | 1. 筛选「待审核」列表，点击申请查看「提交时的申请资料」与「当前账号资料」。<br>2. 若申请者学校邮箱尚未验证，确认「通过」按钮禁用并有明确提示。<br>3. 对已验证邮箱的教师申请填写审核原因并点击「通过」或「拒绝」。<br>4. 切换筛选至「已通过」「已拒绝」「全部状态」核对历史记录。 | 1. 审核通过后该账号获得教师角色，重新进入 `/account/status` 可点击「登入」进入教师工作台。<br>2. 历史记录严格只读，取自当时保存的申请/审核快照，不显示再次决定按钮。 | **Real**（`IdentityAdminApiPages.tsx` `teachers=true` + `/api/v1/admin/teacher-applications`）。 |
| ADM-05 | 课程治理（草稿 / 发布 / 结束） | `/admin/courses`（53） | 侧栏「平台管理 → 课程管理」 | 1. 使用筛选与分页浏览课程列表；在「创建课程草稿」区选择已验证邮箱的有效教师、填写编号/名称/学院/学期/截止时间与创建原因提交。<br>2. 在课程详情内执行生命周期流转：草稿 → 发布（active）→ 结束（ended），检查操作历史与 `VERSION_CONFLICT` 处理。 | 1. 负责教师下拉仅列出 `active` 且已验证邮箱的教师。<br>2. 每次状态变更均记录原因、版本号与操作历史；发布后课程进入教师「我的班级」与学生邀请加课流程。 | **Real**（`GovernanceApiPages.tsx` `screen="courses"` + `c-governance-client.ts`）。 |
| ADM-06 | 系统审计日志（认证审计 & 共享业务审计） | `/admin/logs`（54） | 侧栏「运行分析 → 系统日志」 | 1. 查看认证审计日志（登录/退出/改密/停用/教师审核等动作），按动作类型、结果、时间范围筛选并查看只读详情。<br>2. 切换至共享业务审计日志，按操作人（含系统操作）、角色、目标类型筛选并翻页。 | 两条日志源明确分离，均为只读真实数据库审计记录，支持 URL 筛选重放与请求编号排查。 | **Real**（`GovernanceApiPages.tsx` `screen="logs"`）。 |
| ADM-07 | AI 使用情况与场景统计 | `/admin/ai-usage`（55） | 侧栏「运行分析 → AI 使用情况」 | 1. 在经过前序 AI 提取/规划/摘要/验收/报告操作后打开 `/admin/ai-usage`。<br>2. 按时间范围与功能过滤，核对 5 大场景卡片（GitHub 提交分析、证据群聊追踪、需求解析、任务规划、风险解释）的请求次数、Token 数、费用及「未计价 / Token 不完整」标注；验证无记录时显示「暂无样本」。 | 仅展示后端持久化真实样本，无样本时不伪造估算曲线；费用字段缺失时明确标出缺失条数。 | **混合边界**：统计读取与记录机制为 **Real**；本地 `AI_PROVIDER=fake` 产生 fake 提供方记录（可能显示未计价），真实模型费用需配置 OpenRouter 后产生。 |
| ADM-08 | 异常 / 临时只读访问审批 | `/admin/access-requests`（56）与 `/account/profile` 右栏 | 普通用户 `/account/profile` → `MyAccessRequests`；管理员 `/admin/access-requests` | 1. 非管理员账号在 `/account/profile` 发起临时只读访问申请（如排查特定项目/任务/证据的理由与期限）。<br>2. 管理员进入 `/admin/access-requests` 筛选「待审批」，查看详情与过期时间检查，填写审批原因点击「批准」或「拒绝」。<br>3. 验证已过期表单会禁用提交并提示。 | 审批结果与操作历史持久化，批准的临时只读授权受限于设定截止时间；刷新与版本冲突均受 `VERSION_CONFLICT` 保护。 | **Real**（`GovernanceApiPages.tsx` `screen="access-requests"` & `MyAccessRequests`）。 |
