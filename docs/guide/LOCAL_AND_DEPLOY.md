# 本地开发、测试与部署指引

> 返回 [项目首页](../../README.md) · 另见 [开发与架构设计](ARCHITECTURE.md) · 更新日期：2026-11-27

## 1. 环境要求

- **Node.js**：`>=20 <25`
- **Python**：`3.12`（建议在 `services/api/.venv` 下安装依赖）
- **Docker**：用于运行本地 PostgreSQL（`pgvector/pgvector:pg16` 或 PG 18）与 Redis 容器

## 2. 本地环境变量与启动

```bash
# 1. 安装前端依赖
npm ci

# 2. 复制环境变量模板并按需填写本地凭据（.env 已纳入 .gitignore，切勿提交密钥）
cp .env.example .env

# 3. 启动本地 PostgreSQL 与 Redis
docker compose up -d postgres redis

# 4. 一条命令启动后端（自动调用 scripts/dev-backend.sh + alembic upgrade head）与前端开发服
npm run dev          # Web: http://localhost:3000 | API: http://localhost:8000
```

如需手动分步启动后端或全套容器栈：

```bash
# 手动启动 FastAPI（迁移目录位于 services/api/migrations/，当前 head 为 0047）
cd services/api
alembic upgrade head
uvicorn app.main:app --reload --port 8000

# 或通过 Docker Compose 启动全套容器（postgres / redis / api / worker / risk-scheduler / report-worker / web）
docker compose up --build
```

> **重要运行警示**：
> - **严禁执行 `source .env`**：bash / zsh 会吞掉环境变量值中的反斜杠（例如 `STUDENT_ID_PATTERN` 中的 `\S{4,20}` 会被破坏为 `S{4,20}`），导致运行时学号校验误拒。请始终通过 `scripts/dev-backend.sh` 或直接运行 `uvicorn app.main:app`（Pydantic 自动读取仓库根目录 `.env`）。
> - 默认开启真实业务接口模式（`NEXT_PUBLIC_APP_MODE=real`、`NEXT_PUBLIC_ENABLE_MOCKS=false`）；Staging 与 Production 强制关闭 Mock。修改 `NEXT_PUBLIC_*` 后需重新构建 Web 镜像（`docker compose up -d --build web`）。
> - 本地 `MAIL_MODE=capture` 模式的验证码写入 PostgreSQL `email_outbox` 表，不会向真实邮箱投递。

### 服务端初始化管理员账号

系统不开放公开管理员注册，需在服务端通过受控脚本幂等开通初始管理员（支持密码与/或 Google 身份）：

```bash
cd services/api && python -m scripts.bootstrap_admin \
  --name "系统管理员" --username admin \
  --school-email admin@must.edu.mo --password "<强密码>"
```

## 3. 第三方集成环境变量

密钥仅保存在本地被 gitignore 的 `.env` 或 Railway Service Variables / GitHub Secrets 中，绝不写入仓库：

| 集成能力 | 前端入口 | 关键后端环境变量 |
| --- | --- | --- |
| 学校邮箱验证码发信（Brevo / Resend / SMTP） | 登录/注册弹窗、账户中心 | `MAIL_MODE`（`brevo` / `resend` / `smtp` / `capture`）、`MAIL_PUBLIC_ENABLED`、`MAIL_FROM`、`EMAIL_CHALLENGE_HMAC_KEY`，以及对应通道密钥（`BREVO_API_KEY` / `RESEND_API_KEY` / `SMTP_*`） |
| Google OIDC 登录与账号关联 | 登录页 / 账户中心安全页 | `GOOGLE_CLIENT_ID`、`GOOGLE_CLIENT_SECRET`、`GOOGLE_REDIRECT_URI`（同源 `APP_ORIGIN + /api/v1/auth/google/callback`） |
| GitHub 仓库绑定与多分支同步 | 项目设置 → GitHub 集成 | `GITHUB_APP_ID`、`GITHUB_APP_PRIVATE_KEY`、`GITHUB_APP_SLUG` |
| 个人 GitHub 身份归属 | 账户中心 → 账号安全 | `GITHUB_OAUTH_CLIENT_ID`、`GITHUB_OAUTH_CLIENT_SECRET`（回调 `APP_ORIGIN + /api/v1/auth/github/callback`） |
| 飞书群聊同步与协作洞察 | 项目设置 → 飞书集成 | `FEISHU_APP_ID`、`FEISHU_APP_SECRET` |
| OpenRouter AI（分析 / 验收 / 7 章报告） | 需求分析、验收、报告、活动摘要 | `AI_PROVIDER=openrouter`、`OPENROUTER_API_KEY`、`AI_MODEL`（现网 `deepseek/deepseek-v3.2`）、`AI_REPORT_WRITING_MODEL` / `AI_REPORT_VISUAL_MODEL`（现网 `google/gemini-2.5-flash`） |
| 文件与报告产物存储 | 项目/课程资料、证据附件、报告导出 | `SUPABASE_URL`、`SUPABASE_SERVICE_ROLE_KEY`、`SUPABASE_STORAGE_BUCKET`（未配置时回退 PostgreSQL LOB） |

## 4. 工程校验与测试命令

### 前端与契约校验

```bash
npm run lint                       # ESLint 静态检查
npm run typecheck                  # TypeScript 类型检查 (tsc --noEmit)
npm run build                      # Next.js 生产构建
npm run check:routes               # 56 个设计页 + /projects + /admin 路由校验（CHECK_HTTP=1 核对匿名重定向）
npm run check:i18n                 # zh-Hans / zh-Hant / en 三语键与插值参数一致性
npm run check:ui-catalog           # 中文 UI 翻译目录完整性检查
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
# 格式与静态检查（覆盖 app / migrations / scripts / tests）
cd services/api
ruff format --check app migrations scripts tests
ruff check app migrations scripts tests

# 数据库迁移一致性检查
alembic upgrade head
alembic check

# 后端全量测试（需本地 PostgreSQL 并设置 DATABASE_URL / C_TEST_DATABASE_URL / C_EXECUTION_TEST_DATABASE_URL / B_TEST_DATABASE_URL）
PYTHONPATH=. pytest -q
```

### Playwright 端到端测试

```bash
npx playwright install chromium    # 首次运行安装浏览器
npm run test:e2e                   # 默认隔离套件（已自动排除 teacher-workbench-*）
npm run test:e2e:teacher           # 教师 5-Hub 工作台专属套件 (e2e/teacher-workbench-t1..t5.spec.ts)
npm run test:workspace-real        # 真实模式工作区隔离回归
```

## 5. Railway 三环境上线状态与发布流程

当前三套 Railway 环境均已上线运行（HTTP 200），托管数据库为 PostgreSQL **18.6**（`pgvector`、`pgcrypto`），Alembic 迁移头 **`0047`**，前端强制 `NEXT_PUBLIC_ENABLE_MOCKS=false`：

| 环境 | Git 分支 | Railway 项目 | 线上地址 | 发布门槛 |
| --- | --- | --- | --- | --- |
| Staging | `develop` | `groupproof-staging` | <https://groupproof-staging-production.up.railway.app> | 6/6 CI Job 全部绿灯后由 `scripts/deploy-staging.mjs` 发布 |
| Production | `main` | `groupproof-production` | <https://groupproof-production-production.up.railway.app> | Staging 验收后合并 `main`，6/6 CI Job 绿灯后由 `scripts/deploy-production.mjs` 发布 |
| Admin Console | `admin-backend` | `groupproof-admin` | <https://web-production-650d4574.up.railway.app/admin> | 独立部署，支持顶部在 Staging / Production 数据源间切换 |

- **CI/CD 门禁**：`.github/workflows/ci-cd.yml` 包含 `quality`、`backend`、`e2e`、`c-integration`、`docker` 5 个必需前置检查 Job 与 `deploy` 发布 Job（共 6 个 Job），全部通过后才执行 `deploy-staging.mjs` / `deploy-production.mjs` 与 `deploy-d-workers.mjs`（部署 `report-worker` 与 `risk-scheduler`）。
- **容器入口与健康检查**：
  - API 服务 Railway `rootDirectory` 为 `services/api`，镜像内置中文字体与 Cairo 以支持真实 PDF / DOCX / SVG 报告导出。
  - 容器通过 `services/api/scripts/entrypoint.sh` 按 `RUN_MIGRATIONS_ON_STARTUP` 控制幂等迁移。
  - `/readyz` 严格校验 PostgreSQL Alembic 迁移头（`0047`）及核心依赖就绪状态，不匹配时返回 `503`。

## 6. 延伸阅读

- [开发环境与协作流程](../architecture/DEVELOPMENT.md)
- [生产与三环境部署基线](../architecture/DEPLOYMENT.md)
- [并发压力测试与 AI 成本测算报告](../testing/STRESS_TEST_REPORT.md)
- [后端 API 说明](../../services/api/README.md)
