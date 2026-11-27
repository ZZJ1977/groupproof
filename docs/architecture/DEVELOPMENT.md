# 开发与协作流程

> 更新日期：2026-11-27 · 代码基线：`origin/develop == origin/main`（Alembic 迁移头 `0047`）  
> 返回 [项目首页](../../README.md) · 另见 [本地开发、测试与部署指引](../guide/LOCAL_AND_DEPLOY.md) · [部署基线](DEPLOYMENT.md)

## 1. 环境要求

- **Node.js**：`>=20 <25`
- **npm**：10 或兼容版本
- **Python**：`3.12`（建议在 `services/api/.venv` 安装依赖）
- **Docker Desktop**：运行本地 PostgreSQL（`pgvector/pgvector:pg16` 或 PG 18）与 Redis 容器

检查版本：

```bash
node --version
npm --version
python3 --version
```

## 2. 本地全栈开发

当前前端默认运行在**真实 API 模式**（`NEXT_PUBLIC_APP_MODE=real`、`NEXT_PUBLIC_ENABLE_MOCKS=false`），通过 `/api/v1/*` 同源代理连接本地 FastAPI 后端与 PostgreSQL。

```bash
git clone git@github.com:ZZJ1977/groupproof.git
cd groupproof
npm ci
cp .env.example .env
docker compose up -d postgres redis
npm run dev
```

- `npm run dev` 会自动调用 `scripts/dev-backend.sh`（执行 `alembic upgrade head` 并启动 Uvicorn `:8000`）同时启动 Next.js 开发服（`:3000`）。
- **严禁执行 `source .env`**：bash/zsh 会吞掉反斜杠（破坏 `STUDENT_ID_PATTERN=^\S{4,20}$` 等正则值）。Pydantic 会自动读取仓库根目录 `.env`。
- 如需一键拉起包含 Worker 与调度的全套 Docker 容器（Web、API、worker、risk-scheduler、report-worker、PostgreSQL、Redis）：

```bash
docker compose up --build
```

服务地址：Web `http://localhost:3000`（健康检查 `/healthz`），API `http://localhost:8000`（就绪检查 `/readyz`），PostgreSQL `localhost:5432`，Redis `localhost:6379`。停止并清理本地数据卷：

```bash
docker compose down -v
```

## 3. 环境变量约定

模板文件为 `.env.example`（所有真实密钥只放在被 gitignore 的 `.env`、Railway Variables 或 GitHub Secrets 中，切勿提交到仓库）：

```env
NEXT_PUBLIC_APP_ENV=development
NEXT_PUBLIC_APP_MODE=real
NEXT_PUBLIC_ENABLE_MOCKS=false
NEXT_PUBLIC_API_FEATURES=
API_INTERNAL_URL=http://localhost:8000
DATABASE_URL=postgresql://groupproof:groupproof-local@localhost:5432/groupproof
DATABASE_TIMEZONE=Asia/Shanghai
MAIL_MODE=capture
AI_PROVIDER=fake
```

- `NEXT_PUBLIC_*` 变量会打包进浏览器，只能存放公开配置与开关。
- 本地开发默认 `MAIL_MODE=capture`（验证码写入数据库 `email_outbox` 表）与 `AI_PROVIDER=fake`；联调真实外部能力时在 `.env` 中填入 Brevo/Resend/SMTP、Google OIDC、GitHub App/OAuth、飞书、OpenRouter 与 Supabase Storage 变量即可。
- 仅在需要运行隔离前端夹具/旧 Mock 回归时，才会通过测试配置显式启用 `shared/legacy-mock/`；Staging 与 Production 无条件关闭 Mock。

## 4. OpenAPI 契约与类型生成

`services/api` 是前后端接口契约的唯一权威来源。修改 FastAPI 路由或 Pydantic Schema 后，必须重新导出快照并重新生成 TypeScript 类型：

```bash
# 1. 导出最新 OpenAPI 快照到 packages/domain/openapi.json
cd services/api && PYTHONPATH=. python scripts/export_openapi.py

# 2. 在仓库根目录生成 packages/domain/api.generated.ts
cd ../..
npm run api:generate
npm run test:api-config
npm run test:api-client
```

- 不要手改 `packages/domain/api.generated.ts`。
- 共享客户端封装位于 `shared/lib/api-client.ts` 与各角色端 `student/api/`、`teacher/api/`、`admin/api/`；CI 会执行 `git diff --exit-code packages/domain/api.generated.ts` 校验无漂移。

## 5. 本地校验与测试

### 前端与契约检查

```bash
npm run lint
npm run typecheck
npm run check:routes
npm run check:i18n
npm run check:ui-catalog
npm run test:api-config
npm run check:workspace-isolation
npm run build
```

启动开发服务器或 standalone 服务后，可执行 HTTP 鉴权语义路由检查：

```bash
CHECK_HTTP=1 npm run check:routes
CHECK_AUTH_API=1 npm run check:auth
```

### 后端格式、迁移与 pytest

```bash
cd services/api
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements.txt -r requirements-dev.txt

ruff format --check app migrations scripts tests
ruff check app migrations scripts tests

alembic upgrade head
alembic check
PYTHONPATH=. pytest -q
```

- 迁移文件唯一目录为 `services/api/migrations/versions/`（当前 head 为 `0047`）。每次表结构改动都必须新增迁移并在干净 PostgreSQL 上验证 `alembic upgrade head` 与 `alembic check`。
- 运行完整后端集成测试需配置 `DATABASE_URL`、`C_TEST_DATABASE_URL`、`C_EXECUTION_TEST_DATABASE_URL`、`B_TEST_DATABASE_URL` 指向本地 PostgreSQL。
- 后端测试编写规范见 [services/api/tests/README.md](../../services/api/tests/README.md)。

### Playwright 端到端测试

```bash
npx playwright install chromium    # 首次运行安装
npm run test:e2e                   # 默认 E2E 套件
npm run test:e2e:teacher           # 教师 5-Hub 工作台套件 (t1–t5)
npm run test:workspace-real        # 真实模式工作区隔离回归
```

端到端测试说明见 [e2e/README.md](../../e2e/README.md)。

## 6. 界面多语言（简体 / 繁體 / English）

- 页面可直接用简体中文编写界面文本。`tsconfig.json` 的 `jsxImportSource` 指向 `shared/i18n`，渲染时按当前语言将中文映射至 `shared/i18n/catalog/en.ts` 或 `shared/i18n/catalog/zh-Hant.ts`（涵盖 children 及 DOM 属性 `placeholder` / `title` / `aria-label` / `alt`）。
- 带变量的句子不要直接拼接模板字符串，应使用 `tr("组队截止 {0}", { 0: date })`（`@/shared/i18n/tr`）；`window.confirm` 等非渲染文案同样包裹 `tr()`。
- 新增或修改中文文案后，同步补齐 `shared/i18n/catalog/en.ts` 与 `zh-Hant.ts`，并运行 `npm run check:ui-catalog`。
- 登录、账号、壳层与错误码等使用 `next-intl` 键值文件（`shared/i18n/messages/{zh-Hans,zh-Hant,en}.json`），由 `npm run check:i18n` 校验三语键与插值参数一致。
- 用户输入的业务实体数据（姓名、课程名、项目名、证据正文等）保持原文不翻译。

## 7. 本地生产构建与 Docker

```bash
# 普通生产构建与启动
npm run build
npm run start

# Railway 同款 standalone 启动
npm run build
HOSTNAME=0.0.0.0 PORT=3000 npm run start:standalone

# Docker 镜像构建与本地验证
docker build -t groupproof-web:local .
docker run --rm --name groupproof-web --env-file .env -p 3000:3000 groupproof-web:local
curl --fail http://localhost:3000/healthz
```

## 8. 代码目录与模块所有权边界

| 目录 | 责任边界 |
| --- | --- |
| `app/` | Next.js App Router 路由、全局样式（`globals.css`）与 `/api/v1` 同源代理 |
| `student/` | 学生工作台（课程、项目、执行、评审、API 客户端） |
| `teacher/` | 教师 5-Hub 工作台（页面、组件、图表、助教权限 Hook、API 客户端） |
| `admin/` | 管理员治理控制台（页面、环境切换器、API 客户端） |
| `shared/` | 跨角色壳层、基础与 Lucian UI 组件、认证、首页/收件箱、i18n、工具、领域类型与 `legacy-mock/` |
| `services/api/app/auth` | 统一认证与会话安全（Argon2id、Cookie/CSRF、邮件 OTP、Google OIDC） |
| `services/api/app/modules/a` | A 模块：共享审计、通知、对象存储回执、GitHub/飞书接入、AI 用量与活动摘要 |
| `services/api/app/modules/b` | B 模块：课程、小组、项目初始化、需求基线、计划、里程碑、教师工作台 API |
| `services/api/app/modules/c` | C 模块：任务执行、证据中心、讨论区、项目/课程文件、治理与访问审批 API |
| `services/api/app/modules/d` | D 模块：完整性校验、AI 验收、贡献分析 v2、风险巡检与 7 章节报告导出 API |
| `services/worker/` | 后台异步任务消费者脚手架 |
| `packages/domain/` | 前后端共享 OpenAPI 快照与生成的 TS 类型 |

跨模块需要对方数据时通过服务接口或领域端口调用，不直接越权改写对方专有数据表。

## 9. 分支规范与团队协作（7 分支体系）

仓库（`ZZJ1977/groupproof` 与 `MUST-Workspace/D3-team2-project`）维护 7 条长期分支：

| 分支 | 负责人 / 定位 | 规则 |
| --- | --- | --- |
| `A_task` | **卓子杰（组长）** | 基础底座、认证、GitHub/飞书/AI 集成与架构整合 |
| `B_task` | **郑元泰** | 课程、小组、需求基线、任务规划与教师 5-Hub 工作台 |
| `C_task` | **杨凯景** | 任务执行、证据中心、活动记录、讨论区与文件管理 |
| `D_task` | **林星妤** | 自动验收、贡献核算 v2、风险巡检与 7 章节报告 |
| `admin-backend` | 独立部署分支 | 管理员双环境控制台独立部署 |
| `develop` | 测试集成主干（Staging） | 所有个人分支 PR 的唯一目标，禁止直接推送 |
| `main` | 生产发布主干（Production） | 仅接收经 Staging 验收的 `develop` 同步，禁止直接推送 |

### 同步与提交示例

```bash
# 同步最新 develop 到个人分支
git fetch origin
git switch <成员>_task
git rebase origin/develop   # 若分支已多人协作可改用 git merge origin/develop

# 提交信息遵循 <type>(<scope>): <subject>
git commit -m "feat(B-03): validate task progress"
git commit -m "fix(contribution): tighten cross-task code attribution"
git push --set-upstream origin <成员>_task
```

### Pull Request 规则

1. 目标分支固定为 `develop`，选择对应负责人标签（`A` / `B` / `C` / `D`）。
2. 在标题与描述中注明任务范围、正常路径、权限失败路径与本地测试结果。
3. 必须通过 GitHub Actions 全量 CI 检查并经组长（卓子杰）审查批准后方可合入 `develop`。

## 10. 测试到生产发布链路

```text
成员个人分支 (A_task / B_task / C_task / D_task) 本地校验
  ↓ Pull Request + 组长审查
合入 develop
  ↓ GitHub Actions 6 项 CI/CD（quality / backend / e2e / c-integration / docker -> deploy）
自动部署 Railway Staging（https://groupproof-staging-production.up.railway.app）
  ↓ Staging 验收通过
由组长快进同步 develop -> main
  ↓ GitHub Actions 6 项 CI/CD
自动部署 Railway Production（https://groupproof-production-production.up.railway.app）
```

管理后台独立部署于 <https://web-production-650d4574.up.railway.app/admin>（分支 `admin-backend`），支持在界面顶部按需切换查看 Staging 与 Production 数据。完整 CI/CD 与环境配置细节见 [部署基线](DEPLOYMENT.md)。
