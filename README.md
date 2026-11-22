# GroupProof

GroupProof V1 uses Next.js with a unified FastAPI authentication and business service in `services/api`, backed by the team's PostgreSQL database and migration chain. Authentication supports password sessions, registration review and a Resend mail adapter; public mail remains disabled until delivery is verified. Business pages retain their existing feature switches and integration limits; see [frontend status](FRONTEND_STATUS.md).

## Run locally

Requires Node.js 20 or newer and Docker（后端 PostgreSQL/Redis/API 由 compose 提供）。

```bash
npm ci

# 一条命令：自动拉起后端（postgres/redis/api）→ 执行迁移 → 启动前端
npm run dev          # → http://localhost:3000（后端：http://localhost:8000）
```

`npm run dev` 的前置钩子（`scripts/dev-backend.sh`）会幂等启动 docker 后端并执行
`alembic upgrade head`；没有 Docker 时自动跳过（可自行运行本地后端）。
需要分步或自定义时：

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
