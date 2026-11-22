# GroupProof

GroupProof 是为课程小组作业设计的协作与评估平台。小组交出一份共同成果，老师还需要知道每位同学负责什么、哪些要求已经达到、个人贡献怎么算出来。GroupProof 把分工和验收标准写进任务，让成员在交付时附上对应的代码、测试或文档。老师查看贡献比例时，可以一路点回任务、验收记录和当时引用的证据版本。

## 一项任务怎样变成可核对的贡献

假设两位同学一起做课程项目里的「预约取消」功能。一位负责实现，另一位负责编写测试。小组事先约定两条验收标准：「取消后名额会恢复」和「重复取消不会多释放一个名额」。

1. **约定交付。** 小组把需求拆成任务，写下负责人、任务权重和验收标准。成员确认各自的分工，由组长发布这版计划。
2. **提交证据。** 实现者把 GitHub 合并请求关联到任务，测试者把覆盖两种情形的测试记录关联到相应标准。设计说明、文件版本和飞书讨论也可以作为候选材料。采纳时记录来源和版本，以后仍能查回当时用的是哪一份。
3. **逐项验收。** 把进度填到 100% 后，成员仍需提交验收。系统能核对 PR 是否合并、CI 是否通过。负责人再对照两条标准查看测试内容，决定确认还是退回补证。AI 可以提供分析建议，正式成果需要所有任务负责人确认，并记录合计为 100% 的实际承担比例。
4. **核对贡献。** 假设这项任务权重为 10，两人的实际承担比例确认为 60% 和 40%，这项成果就分别贡献 6 和 4 个权重点。系统按各自累计点数占全组总点数的比例计算项目贡献。老师点开成员详情，可以看到哪些任务计入了这项结果，以及每项任务凭什么通过。

![小组项目总览演示界面，展示任务负责人、任务权重、计划版本和待处理的验收事项](docs/design/screenshots/stage14-07-overview-1440.png)

## 谁在什么时候使用

| 使用者 | 在项目里做什么 |
| --- | --- |
| 学生与组长 | 开工前确认需求和分工，执行中记录进展、提交材料，验收时确认结果。组长推进计划发布，成员可以从自己的贡献详情查看每项成果。 |
| 教师与助教 | 教师从课程总览了解各组进展、逾期风险和待处理事项。需要复核时，可以查看具体小组的任务、贡献明细和证据。助教按所属课程的授权协助。 |
| 管理员 | 审核教师身份、处理账号与访问申请，并查看操作日志和 AI 用量。 |

结课时，小组可以把里程碑、任务完成情况、有效证据、已冻结的贡献结果和风险汇总成一版报告，导出为 PDF 或 Word。证据被撤回或来源发生变化时，历史记录仍可查看，相关验收和贡献可以重新核对。

## 当前版本

`main` 同时包含演示工作区和接入 FastAPI 的业务页面。本地看到的数据取决于所在页面和开发配置。

- **已接入后端的流程**包括账号注册与登录、学校邮箱验证、教师身份审核，以及任务验收和贡献明细。任务执行、证据中心、风险和报告等页面也有真实 API 入口。后端使用 PostgreSQL 保存数据。
- **课程与计划**在主分支保留演示工作区，供查看建组、需求确认和任务规划的交互。B 成员的课程和计划后端在 `B_task` 分支继续开发。
- **外部服务**按需配置。GitHub App 读取仓库活动，飞书应用读取已绑定群的消息，Supabase Storage 保存上传文件，OpenRouter 提供 AI 分析。本地 Compose 默认使用固定的 AI 示例响应。

## 本地运行

在仓库根目录执行以下命令。需要 Node.js 20–24、npm 和已启动的 Docker（含 Compose v2）。

```bash
npm ci
npm run dev
```

开发脚本会启动 PostgreSQL、Redis 和 FastAPI，执行数据库迁移，再启动 Next.js。打开[本地登录页](http://localhost:3000/login)进入应用。若页面能打开但登录服务不可用，可先查看 [API 就绪状态](http://localhost:8000/readyz) 和 `docker compose logs api`。本地开发默认将验证邮件保存到数据库的 `email_outbox` 表。

```bash
docker compose up -d postgres redis api   # 后端（容器启动自动执行 alembic upgrade head）
npm run dev                                # 前端（或 docker compose up -d --build web）
```

如需在服务端受控开通初始管理员账号（不开放公开管理员注册）：

```bash
cd services/api && python -m scripts.bootstrap_admin \
  --name "系统管理员" --username admin \
  --school-email admin@must.edu.mo --password "<强密码>"
```

Open [http://localhost:3000](http://localhost:3000). Sign-in supports password accounts and Google OIDC; configure `GOOGLE_*` to enable Google. Email registration, school-email verification, and password recovery need a mail channel. Local development defaults to the isolated `capture` channel; production can use SMTP or a transactional HTTPS API such as Resend.

Workspaces use real APIs by default (`NEXT_PUBLIC_ENABLE_MOCKS=false`). Both `staging` and `production` enforce real data even if obsolete Mock flags remain. Entering a real workspace removes the retired browser demo cache without touching account or language settings. Test fixtures are loaded only when Mock is explicitly enabled in an isolated development/test environment. Frontend `NEXT_PUBLIC_*` variables are build-time settings: rebuild the Web image after changing them (`docker compose up -d --build web`).

## GitHub and Feishu integrations

| Feature | GroupProof entry | API service configuration |
| --- | --- | --- |
| GitHub repository | Project settings. The project lead connects a repository available to the installed GitHub App. | `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_APP_SLUG` |
| Feishu group | Project settings. The project lead connects a group visible to the Feishu bot. | `FEISHU_APP_ID`, `FEISHU_APP_SECRET` |
| Personal GitHub identity | Account security. Each member can authorize their own account for attribution of project GitHub activity. | `GITHUB_OAUTH_CLIENT_ID`, `GITHUB_OAUTH_CLIENT_SECRET` from a GitHub OAuth App |

Set the variables in the ignored local `.env` or in the deployment's API service. For the personal OAuth App, set its authorization callback URL to the GroupProof Web origin (`APP_ORIGIN`) followed by `/api/v1/auth/github/callback`. With local Docker defaults this is `http://localhost:3000/api/v1/auth/github/callback`. Keep OAuth credentials separate for environments with different Web origins. Personal authorization uses the GitHub account ID and does not request repository access. School-email signup works independently from these integrations.

Repository installations and bot membership determine which provider resources the GroupProof deployment can connect. Install the GitHub App only on repositories intended for GroupProof, and invite its Feishu bot only to groups intended for GroupProof. After a member authorizes GitHub, the next repository sync applies attribution to the activity it reads.

The home page, activity and inbox read the authenticated user's persisted records. Missing integrations report an unavailable state and never substitute sample data.

## Checks

```bash
npm run lint
npm run typecheck
npm run build
npm run check:routes     # 56 页路由 + Admin 工作台入口；CHECK_HTTP=1 时按匿名鉴权语义核对（redirect: manual）
npm run check:access     # 权限矩阵断言（lib/access/policy.ts）
npm run check:i18n       # 简体/繁体/英文词条 key 与插值参数一致性
npm run check:workspace-isolation # 真实模式、旧演示缓存清理及隔离测试兼容
npm run test:workspace-real       # Staging 模式下的浏览器回归（隔离接口）
npm run check:auth       # 需开发服务器：匿名直链/旧链接兼容/登录页文案/404/语言恢复（CHECK_AUTH_API=1 加 API 负面用例）
cd services/api && python -m pytest -q  # 统一后端（需隔离 PostgreSQL，先执行 alembic upgrade head）
npm run check:auth-browser  # 浏览器认证回归（需开发服务器、隔离数据库和捕获邮件的后端）
```

With the development server and backend running: `CHECK_HTTP=1 npm run check:routes` and `CHECK_AUTH_API=1 npm run check:auth`.

## Current scope

- Real: Google OIDC login, server sessions (revocable/rotating), school-email signup (verify school email → complete profile and set password), teacher review, account center, admin teacher review/disable, audit, i18n (zh-Hans / zh-Hant / en), server-side page gating and protected business API authorization. Existing and Google accounts complete any outstanding onboarding steps in the account center.
- Business workspace: real data is the default. The student workspace preserves creation and enrollment actions with empty data. Course invitation, groups, course projects, setup, requirements, planning, task views, milestones and membership changes use authenticated APIs; external services report their actual availability. GitHub and Feishu settings for persisted projects use the integration APIs when the providers are configured.

See [frontend status](FRONTEND_STATUS.md), [API README](services/api/README.md) and unification status（历史归档：`docs/plans/2026-10-12-unified-auth-resend-status.md`） for implementation details and known limitations. Google entry visibility does not imply configured OAuth credentials; real mail requires a verified sender and the public-mail switch.

## Existing develop backend foundation

`services/api` owns both authentication and business APIs. `server/` is retained as historical reference and is no longer the deployed identity entry point. `API_INTERNAL_URL` points Web's identity gate and runtime `/api/v1` proxy to the unified API. Existing generated clients and business feature switches remain available; migrating authentication does not finish unrelated business integrations.

Existing checks remain available:

```bash
npm run api:generate
npm run test:api-config
npm run test:api-client
npm run test:e2e
```

Existing development, deployment and architecture documents remain at [docs/DEVELOPMENT.md](docs/architecture/DEVELOPMENT.md), [docs/DEPLOYMENT.md](docs/architecture/DEPLOYMENT.md) and [docs/TECHNICAL_PLAN.md](docs/architecture/TECHNICAL_PLAN.md).
