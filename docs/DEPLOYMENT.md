# 部署基线

当前仓库是 GroupProof 的 Next.js 前端原型。它可以作为一个独立的 Railway Web 服务运行；真实 API、管理后台、异步任务和数据服务接入后，再按服务边界扩展 Railway 项目。

## 环境策略

使用两个 Railway 项目隔离测试和生产数据：

| 环境 | Git 分支 | Railway 项目 | 用途 |
| --- | --- | --- | --- |
| 测试 | `develop` | `groupproof-staging` | 联调、验收、演示 |
| 生产 | `main` | `groupproof-production` | 面向真实用户 |

当前前端已分别部署到 `groupproof-staging` 和 `groupproof-production`。GitHub Actions 分别将 `develop` 部署到 Staging、将 `main` 部署到 Production。两套环境目前都使用 Mock 数据；后端稳定并完成数据迁移后，再切换生产服务到真实 API。测试和生产使用不同的数据库、Redis、对象存储桶和 OAuth 回调地址。

每个项目建议使用以下服务名：

| 服务 | 当前状态 | 说明 |
| --- | --- | --- |
| `web` | 已支持 | 当前仓库的 Next.js 用户端 |
| `api` | A1 骨架 | FastAPI 健康检查和按成员划分的业务模块入口 |
| `admin` | 预留 | 管理后台；可在同一仓库的 `apps/admin` 中维护 |
| `worker` | A1 骨架 | 可启动的后台任务进程；业务任务后续接入 |
| `postgres` | A1 本地可用 | 本地 pgvector 数据库；生产必须独立于测试 |
| `redis` | A1 本地可用 | 本地队列基础；Celery/SSE 后续接入 |

不要把前端、API 和管理后台强行塞进同一个容器。它们应独立部署、独立扩缩容，并通过环境变量传递地址。

## 当前 Web 服务

Railway 服务根目录保持在仓库根目录，平台会自动检测 `Dockerfile`。容器监听 Railway 注入的 `$PORT`，服务健康检查设置为 `/healthz`。当前服务不需要数据库或密钥就能运行，因为数据仍由浏览器 Mock 层提供。

## A1 本地全套环境

仓库根目录的 `docker-compose.yml` 可以同时启动 Web、FastAPI API、worker、PostgreSQL/pgvector 和 Redis。默认端口分别为 3000、8000、5432 和 6379；使用 `.env` 中的 `*_PORT` 变量可以覆盖宿主机端口。

```bash
cp .env.example .env
docker compose up --build
```

在 Railway 的 `web` 服务中配置：

```text
NEXT_PUBLIC_APP_ENV=staging       # 生产改为 production
NEXT_PUBLIC_ENABLE_MOCKS=true     # API 上线后改为 false
NEXT_PUBLIC_API_BASE_URL=https://<api-domain>
API_INTERNAL_URL=http://api:8000  # 仅在同一 Railway 项目内使用时填写
NEXT_PUBLIC_ADMIN_URL=https://<admin-domain>
```

`NEXT_PUBLIC_` 变量会进入浏览器包，只能放公开地址和功能开关。JWT 密钥、数据库连接串、OAuth secret、对象存储密钥和 Railway token 只能放 Railway Variables 或 GitHub Secrets，不能提交到仓库。

## CI/CD 触发方式

GitHub Actions 在目标分支的 PR 和推送 `develop` 或 `main` 时执行前端质量、Python 后端检查、路由检查、生产构建和 Docker 冒烟测试；全部通过后才执行对应环境的 Railway 部署。Railway 服务自身的 GitHub 自动部署连接已断开，避免绕过 CI 或重复部署。

GitHub 仓库 Actions Secret：`RAILWAY_TOKEN`，存放有 `zzj1977's Projects` 工作区权限的 Railway API Token。工作流将其映射为 Railway CLI 使用的 `RAILWAY_API_TOKEN`。GitHub Environment `staging` 和 `production` 各自设置 `RAILWAY_PROJECT_ID`、`RAILWAY_SERVICE_ID`，避免部署到错误项目。

仓库级变量 `RAILWAY_DEPLOY_STAGING` 和 `RAILWAY_DEPLOY_PRODUCTION` 控制推送后的自动部署；两者为 `true` 时才自动部署。生产发布由负责人在 Staging 验收后推送 `main`。如 GitHub 套餐支持分支保护，可将质量和 Docker 检查设为必需检查。

## 未来扩展为多应用仓库

后端和管理后台开始开发时，建议迁移为以下目录，不改变领域模型和 API 适配边界：

```text
apps/web/       # 当前 app、components、features
apps/admin/     # 管理后台
services/api/   # FastAPI
services/worker/ # Celery/任务消费者
packages/domain/ # 前后端共享的契约与类型
infra/          # 本地 Compose、迁移和运维脚本
```

迁移时为每个应用提供独立 Dockerfile 和 Railway 服务，先保留现有根目录 Dockerfile 以保证当前部署不受影响。API、数据库和后台接入完成后，再把 `NEXT_PUBLIC_ENABLE_MOCKS` 切换为 `false`，并在测试环境先执行迁移和完整验收。
