# 开发与发布流程

## 环境要求

- Node.js >=20 <25
- npm 10 或兼容版本
- Docker Desktop（本地构建容器时需要）

检查版本：

~~~bash
node --version
npm --version
~~~

## 本地开发

~~~bash
git clone git@github.com:ZZJ1977/groupproof.git
cd groupproof
npm ci
cp .env.example .env.local
npm run dev
~~~

打开 http://localhost:3000。当前前端默认使用 Mock 数据，不需要启动后端、数据库或 Redis。

要启动 A1 的全套本地环境（Web、FastAPI、worker、PostgreSQL/pgvector 和 Redis）：

~~~bash
cp .env.example .env
docker compose up --build
~~~

服务地址：Web `http://localhost:3000`，API 健康检查 `http://localhost:8000/healthz`，PostgreSQL `localhost:5432`，Redis `localhost:6379`。停止并删除本地数据卷：

~~~bash
docker compose down -v
~~~

## 环境变量

模板文件为 .env.example：

~~~env
NEXT_PUBLIC_APP_ENV=development
NEXT_PUBLIC_ENABLE_MOCKS=true
NEXT_PUBLIC_API_BASE_URL=http://localhost:8000
API_INTERNAL_URL=http://localhost:8000
NEXT_PUBLIC_ADMIN_URL=http://localhost:3002
DATABASE_URL=postgresql://groupproof:groupproof-local@localhost:5432/groupproof
DATABASE_TIMEZONE=Asia/Shanghai
~~~

NEXT_PUBLIC_ 变量会进入浏览器包，只能放公开地址和功能开关。数据库连接串、JWT 密钥、OAuth secret、对象存储密钥、AI 密钥和 Railway token 只能放在 .env.local、Railway Variables 或 GitHub Secrets。

接入真实 API 后，将 NEXT_PUBLIC_ENABLE_MOCKS 改为 false，并设置 API 地址。

## 本地检查

提交到测试环境前执行：

~~~bash
npm run lint
npm run typecheck
npm run check:routes
npm run build
~~~

后端检查：

~~~bash
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -r services/api/requirements.txt -r services/api/requirements-dev.txt
cd services/api
ruff format --check app migrations scripts tests
ruff check app migrations scripts tests
pytest -q
~~~

数据库迁移和演示数据：

~~~bash
cd services/api
export DATABASE_URL=postgresql://groupproof:groupproof-local@localhost:5432/groupproof
export DATABASE_TIMEZONE=Asia/Shanghai
alembic upgrade head
python -m scripts.seed_core
alembic check
~~~

迁移文件的唯一目录是 `services/api/migrations/`。每次结构变化都要新增迁移并在干净 PostgreSQL 上执行；`seed_core` 只用于本地和测试环境。

前端页面测试：

首次运行需要安装 Chromium 浏览器：

~~~bash
npx playwright install chromium
~~~

之后运行 Playwright 示例：

~~~bash
npm run test:e2e
~~~

示例位于 `e2e/home.spec.ts`，覆盖从登录页点击“使用 Google 登录”进入首页的流程。新增页面测试时，复制该文件到 `e2e/`，修改 `page.goto`、可访问名称和断言即可。后端测试的复制说明见 `services/api/tests/README.md`；页面测试的详细说明见 `e2e/README.md`。

启动开发服务器后，检查 56 个页面的 HTTP 状态：

~~~bash
CHECK_HTTP=1 npm run check:routes
~~~

## 本地生产启动

普通 Next.js 生产服务器：

~~~bash
npm run build
npm run start
~~~

Railway 使用的 standalone 服务器：

~~~bash
npm run build
HOSTNAME=0.0.0.0 PORT=3000 npm run start:standalone
~~~

健康检查地址为 http://localhost:3000/healthz。

## Docker

构建并运行生产镜像：

~~~bash
docker build -t groupproof-web:local .
docker run --rm --name groupproof-web \
  --env-file .env.local \
  -p 3000:3000 \
  groupproof-web:local
~~~

如果没有 .env.local，先执行 cp .env.example .env.local。容器启动后检查：

~~~bash
curl --fail http://localhost:3000/healthz
curl --fail http://localhost:3000/
~~~

## 目录边界

| 目录 | 责任边界 |
| --- | --- |
| 根目录 `app/`、`components/`、`features/`、`lib/` | 当前 Next.js Web 应用，后续迁移入口为 `apps/web` |
| `services/api/app/modules/a` | A 的认证、平台和外部接入 API |
| `services/api/app/modules/b` | B 的课程、项目初始化和任务计划 API |
| `services/api/app/modules/c` | C 的活动、证据和管理后台 API |
| `services/api/app/modules/d` | D 的验收、贡献、报告和教师端 API |
| `services/worker/app/tasks/a-d` | 对应成员的后台任务 |
| `packages/domain` | 前后端共用契约和生成类型 |
| `infra` | Compose、迁移和运维配置 |

目录只表示代码所有权，不改变功能线分工。需要别人的数据时调用对方接口，不直接修改对方的表或模块。

## 组员协作

仓库为私有仓库。负责人在 GitHub 的 Settings → Collaborators → Add people 中邀请成员，普通开发成员使用 Write 权限。

每个成员从 `develop` 创建自己的功能分支。一个任务编号对应一个分支和一个 PR；分支名和 PR 标题都必须包含任务编号：

~~~bash
git fetch origin
git switch develop
git pull --ff-only origin develop
git switch -c feat/C2-01-task-evidence
~~~

本地检查通过后推送功能分支，向 `develop` 提 PR。组员不得直接推送或合并 `develop`，也不得直接推送 `main`：

~~~bash
git add .
git commit -m "feat(C2-01): add task evidence workflow"
git push --set-upstream origin feat/C2-01-task-evidence
~~~

PR 必须：

1. 选择一个负责人标签：`A`、`B`、`C` 或 `D`。
2. 在标题和描述中写任务编号。
3. 填写仓库中的 PR 模板，并说明正常路径、权限失败路径和测试结果。
4. 至少一名成员审查后才能合并；默认由 A 审查，A 的 PR 由 B/C/D 之一审查。
5. 目标分支只能是 `develop`。测试环境验收通过后，由 A 将 `develop` 快进同步到 `main`。

当前 GitHub 分支保护已将 CI 的 `Lint, typecheck, build, and route smoke test`、`Backend format and tests`、`Playwright end-to-end tests` 和 `Build and smoke test Docker image` 设为 `develop`/`main` 的必需检查，并禁止直接推送。仓库中的 `.github/labels.yml` 是 A/B/C/D 标签的版本化定义；重新创建仓库时按该文件恢复标签。

不要提交 .env.local、数据库密码、OAuth secret、AI key 或 Railway token。

## 测试到生产

发布链路固定为：

~~~text
功能分支本地测试
  ↓
推送 develop
  ↓
GitHub Actions 质量检查和 Docker 检查
  ↓
Railway Staging 自动部署
  ↓
测试环境验收
  ↓
develop 同步到 main
  ↓
GitHub Actions 质量检查和 Docker 检查
  ↓
Railway Production 自动部署
~~~

测试环境通过后，由负责人同步到 main：

~~~bash
git switch main
git pull --ff-only origin main
git merge --ff-only origin/develop
git push origin main
~~~

测试环境：

https://groupproof-staging-production.up.railway.app

生产环境：

https://groupproof-production-production.up.railway.app

## CI/CD

工作流文件为 `.github/workflows/ci-cd.yml`，在目标分支的 PR 和 `develop`/`main` 推送时执行：

1. 安装锁定依赖。
2. 执行 lint、TypeScript 和路由检查。
3. 执行 Python 格式检查、lint、编译检查和 pytest。
4. 构建并启动 standalone 服务。
5. 检查首页、健康检查和全部 56 个页面。
6. 构建 Docker 镜像并检查容器和 Compose 配置。
7. 推送到 `develop` 或 `main` 且全部检查通过后，才部署到对应的 Railway 项目。

当前由 GitHub Actions 负责质量门禁和部署：`develop` 部署到 Staging，`main` 部署到 Production。Railway 服务自身的 GitHub 自动部署已断开，避免检查尚未通过时提前部署或重复部署。组员无需持有 Railway Token；部署凭据保存在 GitHub Actions Secret 中。
