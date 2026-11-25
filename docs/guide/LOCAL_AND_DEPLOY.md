# 本地开发、测试与部署指引

> 返回 [项目首页](../../README.md) · 另见 [开发与架构设计](ARCHITECTURE.md)

## 1. 环境要求

- **Node.js**：`>=20 <25`
- **Python**：`3.12`（建议在 `services/api/.venv` 下安装依赖）
- **Docker**：用于运行本地 PostgreSQL 与 Redis 容器

## 2. 本地环境变量与启动

```bash
# 1. 安装前端依赖
npm ci

# 2. 复制环境变量模板并按需填写本地凭据（.env 已纳入 .gitignore）
cp .env.example .env

# 3. 启动本地 PostgreSQL 与 Redis
docker compose up -d postgres redis

# 4. 一条命令启动后端（自动调用 scripts/dev-backend.sh + alembic upgrade head）与前端开发服
npm run dev          # Web: http://localhost:3000 | API: http://localhost:8000
```

如需手动分步启动后端：

```bash
cd services/api
alembic upgrade head
uvicorn app.main:app --reload --port 8000
```

> **重要运行警示**：
> - **严禁执行 `source .env`**：bash / zsh 会吞掉环境变量值中的反斜杠（例如学号正则 `^\S{4,20}$` 会被破坏为 `^S{4,20}$`），导致运行时学号校验误拒。请始终通过 `scripts/dev-backend.sh` 或直接运行 `uvicorn app.main:app`（Pydantic 自动读取仓库根目录 `.env`）。
> - 默认开启真实业务接口模式（`NEXT_PUBLIC_ENABLE_MOCKS=false`）；Staging 与 Production 强制关闭 Mock。修改 `NEXT_PUBLIC_*` 后需重新构建 Web 镜像（`docker compose up -d --build web`）。
> - 本地 `capture` 邮件模式的验证码写入数据库 `email_outbox` 表。

### 服务端初始化管理员账号

系统不开放公开管理员注册，需在服务端通过受控脚本开通初始管理员：

```bash
cd services/api && python -m scripts.bootstrap_admin \
  --name "系统管理员" --username admin \
  --school-email admin@must.edu.mo --password "<强密码>"
```

## 3. 第三方集成环境变量

| 集成能力 | 前端入口 | 关键后端环境变量 |
| --- | --- | --- |
| Google OIDC 登录与账号关联 | 登录页 / 账户中心 | `GOOGLE_CLIENT_ID`、`GOOGLE_CLIENT_SECRET`、`GOOGLE_REDIRECT_URI`（同源 `APP_ORIGIN + /api/v1/auth/google/callback`） |
| GitHub 仓库绑定与同步 | 项目设置 → GitHub 集成 | `GITHUB_APP_ID`、`GITHUB_APP_PRIVATE_KEY`、`GITHUB_APP_SLUG` |
| 个人 GitHub 身份归属 | 账户中心 → 安全与绑定 | `GITHUB_OAUTH_CLIENT_ID`、`GITHUB_OAUTH_CLIENT_SECRET`（回调 `APP_ORIGIN + /api/v1/auth/github/callback`） |
| 飞书群协作洞察 | 项目设置 → 飞书集成 | `FEISHU_APP_ID`、`FEISHU_APP_SECRET` |
| AI 需求分析 / 验收 / 报告 | 项目内 AI 功能 | `OPENROUTER_API_KEY`（或 `AI_API_KEY`）、`AI_MODEL` |

## 4. 工程校验与测试命令

### 前端与契约校验

```bash
npm run lint                       # ESLint 静态检查
npm run typecheck                  # TypeScript 类型检查 (tsc --noEmit)
npm run build                      # Next.js 生产构建
npm run check:routes               # 56 个设计页 + /projects + /admin 路由校验（CHECK_HTTP=1 核对匿名重定向）
npm run check:i18n                 # zh-Hans / zh-Hant / en 三语键与插值参数一致性
npm run test:api-config            # API 功能开关解析冒烟测试
npm run check:workspace-isolation  # 真实模式与旧演示缓存清理隔离校验
npm run check:student-ui           # 学生端 UI 基础契约校验
npm run check:admin-ui             # 管理端 UI 壳层与样式作用域校验
npm run check:admin-pages          # 管理端核心页面契约校验
npm run check:ux                   # 导航上下文与统计口径回归断言
npm run check:access               # 角色权限矩阵断言
npm run api:generate               # 按 packages/domain/openapi.json 重新生成 TS 类型
```

### 后端检查与 pytest

```bash
# 格式与静态检查
ruff format --check services/api
ruff check services/api

# 后端测试（完整集成测试需本地 PostgreSQL，并先执行 alembic upgrade head）
cd services/api && PYTHONPATH=. pytest -q
```

### Playwright 端到端测试

```bash
npm run test:e2e                   # 默认隔离 Mock 套件（已自动排除 teacher-workbench-*）
npm run test:e2e:teacher           # 教师 5-Hub 工作台专属套件 (e2e/teacher-workbench-t1..t5.spec.ts)
npm run test:workspace-real        # Staging 模式下的隔离接口浏览器回归
```

## 5. Railway 部署说明（Staging / Production）

- **Staging (`develop` 分支)**：推送至 `develop` 触发 GitHub Actions CI（lint / typecheck / build / OpenAPI 快照一致 / 后端 pytest / Playwright e2e），随后通过 `node scripts/deploy-staging.mjs` 或 Railway 自动部署发布。
- **Production (`main` 分支)**：Staging 验收通过后合并至 `main`，使用 `node scripts/deploy-production.mjs` 发布 Web 与 API，并可按需执行 `node scripts/deploy-d-workers.mjs` 部署异步报告与风险调度 Worker。
- **容器入口与健康检查**：
  - API 服务 Railway `rootDirectory` 固定为 `services/api`，镜像内置中文字体与 Cairo 以支持 PDF/SVG 报告导出。
  - 容器通过 `services/api/scripts/entrypoint.sh` 按 `RUN_MIGRATIONS_ON_STARTUP` 控制自动迁移。
  - `/readyz` 严格校验数据库 Alembic 迁移头（当前 `0047`）及核心依赖就绪状态，不匹配时返回 `503`。

## 6. 延伸阅读

- [开发环境详细说明](../architecture/DEVELOPMENT.md)
- [生产与 Staging 部署参考](../architecture/DEPLOYMENT.md)
- [后端 API 说明](../../services/api/README.md)
