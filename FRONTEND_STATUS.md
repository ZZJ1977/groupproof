# GroupProof V1 前端交付状态

更新日期：2026-10-10

## 2026-10-10 迭代：注册进度与「登入」按钮（阶段配色/文案/可选账号安全/会话升级进入业务）

- **注册进度（侧栏四项）**：整行底色三态——前三项完成=浅蓝（勾选图标+“已完成”），未完成/未通过=浅红（“待完成”；教师按事实显示“待提交/审核中/未通过”），账号安全未完成=浅灰（“可选”），完成后浅蓝；每行同时有文字/图标（不只靠颜色）；选中页以边框/侧线/字重/`aria-current="page"` 区分，不与“已完成”混用；加载中中性占位、读取失败给重试，未知状态不标完成。
- **文案统一**：“完成 / 教师审核”→“身份确认（学生/教师）”（第 3 页标题/面包屑/三语同步）；“账户安全”→“账号安全”并标注“可选”；补齐缺失词条 `account.status.basis.password_auth`（界面不再出现原始 key）。
- **可选账号安全**：不计入必填进度、不阻碍正常进入、不要求再改一次密码/绑定 Google（新注册即满足：可用密码凭据+登录邮箱已验证，或纯 Google 可信认证事实）。
- **状态提示与「登入」按钮**：前三项全部完成时黄色“待完善基本资料”替换为绿色完成态“完成注册”，否则显示实际待办（待完善基本资料/待验证学校邮箱/待提交/审核中/审核未通过/账户已停用）；状态提示下新增「登入」按钮：前三项未完成时灰色且真实 `disabled`（旁注尚缺阶段），完成后绿底白字可点击（账号安全可选未完成不影响）；点击后调用 `POST /api/v1/auth/session/refresh` 重新核验资格并升级/轮换会话，进入 `/home` 或经校验的 returnTo；失败留页解释、401 引导重新认证。
- **后端配套**：`derive_facts` 新增 `identityConfirmed`/`securityComplete`/`requiredCompletedCount`，`canEnterWorkspace` 与 guard 门禁同口径；修复 `session/refresh` 轮换时**不写回新 Cookie**的缺陷（旧 Cookie/旧 CSRF 立即失效会造成断链）；修复 `BUSINESS_DATA_FILE` 只认环境变量不读 `.env` 的缺口（业务接口 503）。
- **验证（2026-10-10 实际运行）**：server pytest **114 项**（新增 `test_registration_progress` 7 项：事实派生/教师审核门槛/会话轮换写回/可选安全/失效退回）、`lint/typecheck/build`、`check:i18n`（466 键）、`CHECK_HTTP=1 check:routes`、`check:auth`、`check:auth-browser`（19 项）、`check:browser`（33 项）、`check:ux`（16 项）、新增 `check-registration-progress`（**42 项真实 Chrome**，含状态截图 8 张）。细节、截图与遗留项见[阶段报告](./docs/development-stages/stage-reports/2026-10-10-注册进度与登入按钮.md)。
- **验收临时密令（同日附加，用户验收便利）**：`ACCEPTANCE_TEST_TOKEN`（当前 `202610`，仅非 real；real 配置即启动失败）——注册“登录邮箱”框输入直达信息完善页（全新测试账户+真实会话，不跳过必填阶段），验证码框输入同一密令直通学校邮箱/登录邮箱验证；退出重登用资料页的 `testXXXXXX` + 密令。**验收后删除该配置即移除**。顺带修复：邮箱格式错误 500→400 字段错误（4 处）、`getAuthSession` 截断响应崩页→可重试服务不可用。验证：server pytest **118 项**（新增 `test_acceptance_entry` 4 项）、`check-registration-progress` **47 项**（新增 R8 密令场景）、lint/typecheck/build 通过。详见[报告](./docs/development-stages/stage-reports/2026-10-10-验收临时密令.md)。
- **验收反馈 4 项（同日）**：① 资料页“修改密码”面板替换为“注意事项提示”（4 条三语；改密入口保留在“账号安全”页）；② 个人中心侧栏语言选择器删除，仅留页面右上角；③ 修复顶栏语言名重复显示（`language-switcher` 紧凑模式双 span）；④ 清空 `gp_dev` 已注册用户信息（清理前 94 用户/187 会话/619 审计；保留迁移 0003 与验收密令，清库后实测密令注册仍可用）。验证：lint/typecheck/build、i18n **470 键**、`check-registration-progress` **51 项**（含 4 项新 UI 断言）。详见[报告](./docs/development-stages/stage-reports/2026-10-10-资料页优化与语言去重及清库.md)。

## 2026-10-09 迭代：注册故障修复（R0）与独立邮箱注册/密码恢复（R1）

- **R0 根因与修复**：注册失败主因=无配置启动时 `DATABASE_URL` 默认值与实际库凭据不一致（后端日志 `password authentication failed for user "gp"`，请求 503 SERVICE_UNAVAILABLE），叠加 healthz 不查库、错误无分类日志、`.env` 路径漂移、build/dev 共用 `.env`→`.next` 缓存冲突。修复：稳定路径配置加载、`server/scripts/start-dev.sh` 统一启动（含幂等迁移与脱敏配置输出）、`/readyz`、错误分类+requestId、`distDir` 分离、提供方开关与 capabilities。
- **R1 独立邮箱注册**：三步闭环（登录邮箱→真实验证码→用户名/密码建档），`pre_registration_requests` 限时一次性建档资格+浏览器事务绑定+服务端限流；旧无验证码注册路径 410 封堵；登录邮箱（允许 QQ 等）与学校邮箱分别存储验证状态；新密码 Argon2id、历史 bcrypt 兼容并登录升级。
- **R1 密码恢复/历史账户**：忘记密码（统一安全反馈、已验证登录邮箱限定）+ 重置（令牌单次消费/凭据版本绑定/撤销旧会话与恢复凭据）；历史未验证登录邮箱会话限 onboarding 并提供 `/account/security` 受限补验，不可被他人经注册/找回接管。
- **UI**：注册弹窗三步（进度/脱敏邮箱/倒计时重发/改邮箱）、忘记密码弹窗、`/reset-password` 公开页（fragment 令牌即刻清除）、能力感知（Google 未配置隐藏）、错误含请求编号与限流倒计时；三语词条 439 键。
- **验证（2026-10-09 实际运行）**：server pytest **107 项**、迁移 0001–0003 真实 PostgreSQL、curl 经代理三步注册/找回/重置端到端、`check:auth`、`check:auth-browser`（19 项真实 Chrome）、`check:browser`（33 项）、lint/typecheck/build、业务断言无回归；E01–E22 矩阵见[阶段报告](./docs/development-stages/stage-reports/2026-10-09-注册故障修复与独立邮箱注册.md)（E21 真实收件未验证）。
- 顺带修复真实回归：命令层缓存键按用户隔离、工作区加载可恢复回退、768px 顶栏溢出。

## 2026-10-08 迭代：登录鉴权、注册闭环、用户数据库与全站语言

## 2026-10-08 迭代：登录鉴权、注册闭环、用户数据库与全站语言

- **真实身份服务**：新增 `server/`（FastAPI + PostgreSQL + Alembic）。Google OIDC（Authlib、PKCE S256、state/nonce 事务）、可撤销/轮换会话、注册资格派生（disabled → profile → email → teacher review → active）、学校邮箱验证码（HMAC/一次性/限流/原子绑定）、教师申请审核、停用、审计；接口与字段见 [`server/README.md`](./server/README.md)、[`server/docs/DB_FIELD_DICTIONARY.md`](./server/docs/DB_FIELD_DICTIONARY.md) 与[接口交接表](./docs/development-stages/13-接口交接表.md)。`APP_MODE=real` 缺真实配置直接启动失败，不退回 Mock。
- **页面门禁与登录页**：`app/[[...slug]]/page.tsx` 服务端按路由分类守卫（守卫先于业务 Provider）；登录页含 Google 入口与「已注册账户登录」窗口（用户名/邮箱 + 密码注册/登录，bcrypt 入库，2026-10-08 新增；旧“完善个人资料/验证邮箱”入口及 onboarding 链接已移除），旧 `/onboarding/*` 跳 `/account/*` 并经相同门禁；未知路由 404 不加载工作区。
- **个人中心**：`/account/profile|email|status`（受限注册与已激活共用）；资料白名单 + 字段级错误 + `expectedVersion`；学校邮箱发码/验证/重发/换绑独立流程；状态页区分“学校邮箱已验证”与“学校实名未核验”（首期保持申报标记）；移除“稍后完成进首页”。
- **会话与缓存**：工作区头像菜单改个人中心/我的记录/真实退出（撤销会话 + 清理缓存）；演示角色选择器仅 `NEXT_PUBLIC_APP_MODE=mock` 出现；业务缓存按 userId 隔离；停用/退出/换权即时生效。
- **全站语言**：简体 `zh-Hans` / 繁體 `zh-Hant` / English `en`（next-intl，无语言 URL 前缀）。解析优先级：`gp_locale` Cookie > 账户 `preferredLocale` > Accept-Language > zh-Hans；切换保留页面/步骤/未保存输入；HTML lang/日期格式跟随 locale（时区 Asia/Macau）。词条覆盖登录、个人中心、工作区壳、首页/通知/待处理/个人动态、共享状态组件与错误码（331 键 ×3，`npm run check:i18n` 校验一致）；业务视图内部文案待继续提取（见“已知限制”）。
- **验证（2026-10-08 实际运行）**：`server` pytest 89 项（含账号密码注册/登录 11 项）（隔离 PostgreSQL + 测试 OIDC + 邮件捕获；D01–D08、A 系列、权限矩阵）；`lint/typecheck/build`、`check:routes`（含 `CHECK_HTTP=1` 鉴权语义）、`CHECK_AUTH_API=1 check:auth`、14 套业务断言（529 项）与 `check:browser`（33）全部通过。证据与遗留项见[迭代总结](./docs/development-stages/stage-reports/2026-10-08-登录鉴权注册与语言.md)与[账号密码登录总结](./docs/development-stages/stage-reports/2026-10-08-账号密码登录.md)。

## 已完成（历史，2026-10-06）

- 已按《UI 设计合集》纳入全部 56 页。逐页名称和实际 URL 见 [`FRONTEND_IMPLEMENTATION_PLAN.md`](./FRONTEND_IMPLEMENTATION_PLAN.md#56-页路由映射)。其中任务树、看板、列表对应同一任务数据集的三种视图。
- 基础入口 01–06、个人动态 30；项目启动、任务、里程碑与验收 07–20；开发协作、贡献、报告与设置 21–29；课程与小组 31–40；教师端 41–50；Admin 51–56。
- Next.js App Router、TypeScript strict、Tailwind CSS、本地 shadcn/ui 风格控件、Lucide 图标、TanStack Query、React Hook Form + Zod、next-intl 中文环境。
- 学生/组长、教师/助教、Admin 三套导航和前端角色入口。桌面优先，并在窄屏使用抽屉导航和可横向滚动的密集表格。
- 六步项目初始化、需求基线版本、任务规划、共享 Task Tree/Board/List、任务详情、证据提交/完整性检查、逐项 AI 验收与人工确认、课程组队及变更、教师处理、Admin 教师审核均有可操作状态。
- 搜索、筛选、Tab、Dialog、Dropdown、表单和 Admin 用户分页可操作。通知已读、任务状态等变更跨视图更新并在本机浏览器刷新后保留。

## Mock 数据与服务

- [`mocks/seed.ts`](./mocks/seed.ts) 使用稳定 ID 关联 Course → Group → Project → Requirement → Functional Module → Task/Subtask → Acceptance Criterion → Evidence → Verification → Contribution → Report，并包含通知、待处理、GitHub、飞书、教师和审计样本。
- [`lib/api/mock-service.ts`](./lib/api/mock-service.ts) 以 Promise 提供数据读取，浏览器 `localStorage`（按 userId 隔离）保存演示状态；[`lib/workspace.tsx`](./lib/workspace.tsx) 提供 TanStack Query 缓存、集合级新增/更新/移除。相关任务/证据/标准变更会使当前验收结果失效。
- 登录/注册/会话/邮箱验证/教师审核已为真实服务；AI 分析/验收、GitHub/飞书同步、文件上传记录、报告生成仍为浏览器本地模拟（仅在真实 active 会话后挂载）。业务权限展示为前端门禁，最终授权由 FastAPI 在数据接口执行（业务接口迁移中）。

## 权限资格层（2026-10-06，阶段 01）

- 新增 [`lib/access/policy.ts`](./lib/access/policy.ts)：只读纯函数 `can(data, actorId, action, target)` 统一判断账号角色、资源关系与操作资格；组长按目标 `Group.leaderId` 或无小组项目 `ownerId` 判断，助教按 `Course.assistantGrants` 授权，默认只读。权限仍为前端演示门禁，不构成真实鉴权。
- 助教改为独立演示账号 `ta-1`（归属 `course-1`）；`Project.ownerId` 与项目 `visibility` 已入领域类型与种子（`project-1` 为课程内可见）。旧浏览器缓存需清空 `groupproof-v1-workspace` 后才能看到新种子字段。
- 项目页（07–29）统一按 `project.summary.read` / `project.content.read` 选择视图：仅有公开总览资格时展示 `ProjectSummary` DTO（id/name/description/progress/lifecycle）。B 页面写入口（08–10、23、29、35、38–40、46–47）已接操作资格门禁；其他模块写入口待迁移，清单见 [`docs/development-stages/01-写入口迁移清单.md`](./docs/development-stages/01-写入口迁移清单.md)。
- 权限矩阵断言测试：`npm run check:access`（53 项）；阶段记录见 [阶段总览](./docs/development-stages/README.md)。

## 版本模型（2026-10-06，阶段 02）

- 新增 [`lib/versioning.ts`](./lib/versioning.ts)：`Revision` 不可变正式快照 + 独立草稿；确认绑定 revisionId/contentVersion/名单（`confirmMember`/`confirmationsComplete`）；`migrateWorkspace` 旧数据迁移（幂等，`legacy.confirmedUserIds` 不伪造历史时间）。
- MockData 新增 `schemaVersion` 与基线/计划/课程规则修订集合；旧浏览器数据迁移时备份到 `groupproof-v1-workspace-legacy-backup`。
- 版本页（08/09/10）区分当前正式版本/待确认草稿并显示逐人确认时间；断言测试 `npm run check:versioning`。

## 业务命令层（2026-10-06，阶段 03）

- 新增 [`lib/commands/`](./lib/commands/)：统一写入口（输入校验/会话身份/权限/版本/状态/原子保存/日志）；`project.archive` 为完整链路示例，其余命名命令注册后待 04–11 各阶段实现，未实现操作明确报错不伪造成功。
- 页面 29 归档已走命令；`useCommands` 提供有类型操作与 pending；保存失败不更新缓存。断言测试 `npm run check:commands`。
- 阶段 04 起课程设置/规则草稿/规则发布/助教授权均走命令（`lib/commands/course.ts`）；规则草稿与已发布版本分离，学生总览读取最新已发布版本；断言测试 `npm run check:course-rules`。
- 阶段 05–08：课程项目创建、需求基线、初始化六步、任务规划与发布均走命令（`lib/commands/`），版本快照/确认/结构校验有独立断言（`check:project-create` / `check:baseline` / `check:setup` / `check:plan`）。
- 阶段 09–13（2026-10-06）：规则变更真实差异、文件版本、设置/生命周期、总览统计均完成命令化/选择器化；`npm run check:rule-change / files / lifecycle / overview / e2e` 覆盖；后端接口契约见 [`docs/development-stages/13-接口交接表.md`](./docs/development-stages/13-接口交接表.md)。13 套断言共 513 项全部通过。

## UX 改版（2026-10-06，阶段 14–15 本轮范围）

- 规范：`docs/development-stages/14-UX设计规范.md`（四类模板、Tokens、组件状态表、56 页映射）、`15-动效规范.md`；截图 `docs/design/screenshots/`。
- 共享组件：globals.css 新基线 Tokens（#F8FAFC/#0F172A/#0369A1、间距/圆角/动效、prefers-reduced-motion 降级）、`components/common.tsx` Feedback/SaveState、`components/ui/button.tsx` loading 态；导航上下文与教师统计口径修复（`lib/ux/`）。
- 页面：07/10/47 代表页 + 08/09/23/29/35/38–40/46 推广完成主操作/反馈统一；其他成员页面按规范 §8 清单接入。
- 验证：`npm run check:ux`（16）、`npm run check:browser`（33，Chrome 实拍/界面操作）通过；业务断言 14 套 529 项无回归；lint/typecheck/build/check:routes 通过。

## 待后端与真实集成

- 身份与鉴权已落地（`server/`，2026-10-08）；**未联调**：真实 Google OAuth（缺 GOOGLE_CLIENT_ID/SECRET/REDIRECT_URI 与控制台回调登记）、真实学校邮件投递（缺 SMTP 凭据/发信策略）。代码路径已用隔离测试 OIDC/邮件捕获器验证，未宣称真实联调通过。
- 业务数据：课程/小组/项目/任务/证据/验收/贡献/报告业务 API 与状态机待迁入 FastAPI（接口契约见 [`docs/development-stages/13-接口交接表.md`](./docs/development-stages/13-接口交接表.md)）；FastAPI 侧授权管线（会话+注册资格+资源权限）已实现并测试，real 模式未接真实业务存储时对应接口返回 SERVICE_UNAVAILABLE（不回退 Mock）。
- 存储：PostgreSQL 已用于身份/注册/会话（真实迁移/约束/并发已验证）；文件对象存储、Redis/Celery 后台任务、SSE 进度推送尚未连接。
- 第三方：GitHub 仓库/Commit/PR/CI 同步、飞书只读协作记录、AI 需求分析和验收仍使用关联 Mock 记录与模拟动作。
- 导出：PDF 目前调用浏览器打印；Word 下载为 HTML 兼容的 `.doc` 演示文件。正式 PDF/DOCX 生成应由后端或专门导出服务接管。

## 已知限制与设计差异

- 视觉按 56 页设计稿的布局、信息层级与配色重建，使用可维护的共享组件；未做逐像素复刻。少量长表格在手机上横向滚动。
- 当前 Mock 贡献份额是可追溯样本快照，任务/证据变化不会重新计算正式贡献比例；正式规则和异议裁定等待后端实现。
- 学校邮箱验证码为真实服务端流程；真实邮件投递需配置 SMTP（当前开发/测试用邮件捕获器，生产禁止）。Google 登录、教师审核与管理员治理均为服务端校验；真实 Google 凭据联调未做。
- 资料上传只保存文件名、大小等浏览器内的 Mock 元数据，不保存文件内容；SSE 和真实异步作业尚未接入。
- **i18n 覆盖范围**：登录、个人中心、工作区壳、首页/通知/待处理/个人动态、共享状态组件与错误码已三语（331 键）；业务视图（07–29、31–50、51–56 的页面内部文案）仍为中文硬编码，继续按 `check:i18n` 约定提取；用户业务内容（姓名/课程/项目/证据原文）保持原文不翻译。
- `npm audit --omit=dev --audit-level=moderate` 为 0 漏洞。完整开发依赖审计仍报告 `eslint-config-next → fast-glob → micromatch → braces` 的 5 项高危传递告警；目前上游没有同主版本的修复路径，生产依赖不受该报告影响。

## 验证与运行

- 前端：`npm install`、`npm run lint`、`npm run typecheck`、`npm run build`、`npm run check:routes`、`npm run check:access`、`npm run check:versioning`、`npm run check:i18n` 均通过。
- 后端：`server` 内 `pytest tests/ -q`（78 项）针对隔离 PostgreSQL 通过；迁移 `alembic upgrade head` 在 PostgreSQL 16 实例验证。
- 运行开发服务器与 uvicorn 时：`CHECK_HTTP=1 npm run check:routes`（匿名鉴权语义，redirect:manual）、`CHECK_AUTH_API=1 npm run check:auth`（直链绕过/旧链接/登录页文案/404/语言恢复）通过。
- 启动：后端 `npm run server:dev`（或 `server` 内 uvicorn），前端 `npm run dev -- --port 3000`，打开 `http://localhost:3000/`。演示角色选择器仅隔离演示模式（`NEXT_PUBLIC_APP_MODE=mock`）可用。

## 目录

```text
app/                 App Router 入口与全局样式
components/          工作区导航、共用展示和 UI 控件
features/core/       登录、首页、通知、待办、个人动态
features/project-core/ 项目启动、需求、任务、里程碑、证据、验收
features/project-support/ 开发协作、贡献、报告、项目设置
features/course/     课程和小组工作流
features/governance/ 教师与 Admin 页面
lib/api/             Mock 服务适配器
lib/                 路由解析、工作区状态与工具
mocks/               关联种子数据
types/               领域类型
scripts/             56 路由检查
```

## 2026-10-06 安装修复复核

- 问题：`npm ci` 报 `Missing: @swc/helpers@0.5.23 from lock file`，锁文件遗漏了 `next-intl` 下 SWC 所需的间接依赖。
- 修复：在 `package-lock.json` 中补齐 `node_modules/next-intl/node_modules/@swc/helpers`；保留原有依赖版本、跨平台元数据和 `package.json`。
- 验证环境：Node.js 22.22.3、npm 10.9.8。`npm ci --no-audit --no-fund` 安装成功；`npm run build`（含 lint 和类型检查）通过；`npm run check:routes` 通过。
- 临时开发服务器中执行 `CHECK_HTTP=1 npm run check:routes`，56 个设计页面全部返回 HTTP 200。验证后已停止临时服务器，日常启动继续使用 `npm run dev`。

## 2026-10-10 提交前代码审查

已修复会话/CSRF 同步、停用账号展示、Google 绑定状态、后端 OAuth/改密/教师换绑资格与业务草稿/计划重新发布问题。完整发现、回归结果、迁移要求和验证边界见 [代码审查记录](docs/reviews/2026-10-10-code-review.md)。
