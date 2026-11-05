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
docker compose up -d postgres redis api   # 后端
docker compose exec api alembic upgrade head
npm run dev                                # 前端（或 docker compose up -d web）
```

Open [http://localhost:3000](http://localhost:3000). Sign-in supports password accounts and Google OIDC; configure `GOOGLE_*` to enable Google. Email registration, school-email verification, and password recovery need a mail channel. Local development defaults to the isolated `capture` channel; production can use SMTP or a transactional HTTPS API such as Resend. The demo role selector only appears in the isolated demo mode (`NEXT_PUBLIC_APP_MODE=mock`).

## Checks

```bash
npm run lint
npm run typecheck
npm run build
npm run check:routes     # 56 页路由映射；CHECK_HTTP=1 时按匿名鉴权语义核对（redirect: manual）
npm run check:access     # 权限矩阵断言（lib/access/policy.ts）
npm run check:i18n       # 简体/繁体/英文词条 key 与插值参数一致性
npm run check:auth       # 需开发服务器：匿名直链/旧链接兼容/登录页文案/404/语言恢复（CHECK_AUTH_API=1 加 API 负面用例）
cd services/api && python -m pytest -q  # 统一后端（需隔离 PostgreSQL，先执行 alembic upgrade head）
npm run check:auth-browser  # 真实 Chrome：注册三步/登录/找回/重置、键盘与窄屏（需开发服务器+后端）
```

With the development server and backend running: `CHECK_HTTP=1 npm run check:routes` and `CHECK_AUTH_API=1 npm run check:auth`.

## Current scope

- Real: Google OIDC login, server sessions (revocable/rotating), registration gate (profile → school email verification → teacher review), account center, admin teacher review/disable, audit, i18n (zh-Hans / zh-Hant / en), server-side page gating and protected business API authorization.
- Mock (browser-local, behind real gating): the 56 design pages' business data (courses, projects, tasks, evidence, AI, GitHub/Feishu, file metadata, exports).

See [frontend status](FRONTEND_STATUS.md), [API README](services/api/README.md) and [unification status](docs/plans/2026-10-12-unified-auth-resend-status.md) for implementation details and known limitations. Google entry visibility does not imply configured OAuth credentials; real mail requires a verified sender and the public-mail switch.

## Existing develop backend foundation

`services/api` owns both authentication and business APIs. `server/` is retained as historical reference and is no longer the deployed identity entry point. `API_INTERNAL_URL` points Web's identity gate and runtime `/api/v1` proxy to the unified API. Existing generated clients and business feature switches remain available; migrating authentication does not finish unrelated business integrations.

Existing checks remain available:

```bash
npm run api:generate
npm run test:api-config
npm run test:api-client
npm run test:e2e
```

Existing development, deployment and architecture documents remain at [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md), [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) and [docs/TECHNICAL_PLAN.md](docs/TECHNICAL_PLAN.md).
