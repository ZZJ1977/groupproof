# GroupProof

GroupProof V1 is a runnable Next.js frontend prototype for group-project collaboration, with a real FastAPI identity service (Google sign-in, registration review, sessions) backed by PostgreSQL. Business pages still run on local mock data behind real server-side access gating; see [frontend status](FRONTEND_STATUS.md) for exact scope and known limitations.

## Run locally

Requires Node.js 20 or newer and Python 3.11+ (backend).

```bash
npm ci

# 1) 隔离 PostgreSQL（开发/测试）与迁移
docker run -d --name gp-pg-test -e POSTGRES_USER=gp -e POSTGRES_PASSWORD=gp_test_pw \
  -e POSTGRES_DB=gp_test -p 55432:5432 postgres:16-alpine
cd server && python3 -m venv .venv && ./.venv/bin/pip install -r requirements.txt
# 统一启动（自动检查数据库/迁移并幂等执行；读取仓库根目录 .env）
cd .. && npm run server:dev

# 2) 前端（另开终端；配置见 .env.example）
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). Sign-in uses real Google OIDC (configure `GOOGLE_*` per [.env.example](.env.example)); without credentials the login start returns a clear service-unavailable error. The demo role selector only appears in the isolated demo mode (`NEXT_PUBLIC_APP_MODE=mock`).

## Checks

```bash
npm run lint
npm run typecheck
npm run build
npm run check:routes     # 56 页路由映射；CHECK_HTTP=1 时按匿名鉴权语义核对（redirect: manual）
npm run check:access     # 权限矩阵断言（lib/access/policy.ts）
npm run check:i18n       # 简体/繁体/英文词条 key 与插值参数一致性
npm run check:auth       # 需开发服务器：匿名直链/旧链接兼容/登录页文案/404/语言恢复（CHECK_AUTH_API=1 加 API 负面用例）
npm run server:test      # 后端 pytest（隔离 PostgreSQL + 测试 OIDC + 邮件捕获；D/A/E 系列）
npm run check:auth-browser  # 真实 Chrome：注册三步/登录/找回/重置、键盘与窄屏（需开发服务器+后端）
```

With the development server and backend running: `CHECK_HTTP=1 npm run check:routes` and `CHECK_AUTH_API=1 npm run check:auth`.

## Current scope

- Real: Google OIDC login, server sessions (revocable/rotating), registration gate (profile → school email verification → teacher review), account center, admin teacher review/disable, audit, i18n (zh-Hans / zh-Hant / en), server-side page gating and protected business API authorization.
- Mock (browser-local, behind real gating): the 56 design pages' business data (courses, projects, tasks, evidence, AI, GitHub/Feishu, file metadata, exports).

See [frontend status](FRONTEND_STATUS.md) and [server README](server/README.md) for implementation details and known limitations.
