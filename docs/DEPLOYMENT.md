# 部署基线

当前仓库是 GroupProof 的 Next.js 前端原型。它可以作为一个独立的 Railway Web 服务运行；真实 API、管理后台、异步任务和数据服务接入后，再按服务边界扩展 Railway 项目。

## 环境策略

使用两个 Railway 项目隔离测试和生产数据：

| 环境 | Git 分支 | Railway 项目 | 用途 |
| --- | --- | --- | --- |
| 测试 | `develop` | `groupproof-staging` | 联调、验收、演示 |
| 生产 | `main` | `groupproof-production` | 面向真实用户 |

当前前端已分别部署到 `groupproof-staging` 和 `groupproof-production`，分别跟踪 `develop` 与 `main`。两套环境目前都使用 Mock 数据；后端稳定并完成数据迁移后，再切换生产服务到真实 API。测试和生产使用不同的数据库、Redis、对象存储桶和 OAuth 回调地址。

每个项目建议使用以下服务名：

| 服务 | 当前状态 | 说明 |
| --- | --- | --- |
| `web` | 已支持 | 当前仓库的 Next.js 用户端 |
| `api` | 预留 | FastAPI 身份、权限和业务接口 |
| `admin` | 预留 | 管理后台；可在同一仓库的 `apps/admin` 中维护 |
| `worker` | 预留 | AI、报告导出和异步任务 |
| `postgres` | 预留 | 业务数据库，生产必须独立于测试 |
| `redis` | 预留 | 队列、缓存和 SSE 协调 |

不要把前端、API 和管理后台强行塞进同一个容器。它们应独立部署、独立扩缩容，并通过环境变量传递地址。

## 当前 Web 服务

Railway 服务根目录保持在仓库根目录，平台会自动检测 `Dockerfile`。容器监听 Railway 注入的 `$PORT`，服务健康检查设置为 `/healthz`。当前服务不需要数据库或密钥就能运行，因为数据仍由浏览器 Mock 层提供。

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

GitHub Actions 已经执行 lint、TypeScript、路由检查、生产构建和 Docker 冒烟测试。每个 Railway 项目选择一种部署触发方式：

1. 简单模式：Railway GitHub 集成分别连接 `develop` 和 `main`，由 Railway 在检查通过后部署。
2. 门禁模式：关闭 Railway 的自动 GitHub 部署，由 `.github/workflows/ci-cd.yml` 的 deploy job 在质量检查和 Docker 检查通过后执行。

不要同时启用两种触发方式，否则一次推送会产生两次部署。生产分支应启用保护规则，并要求 `quality` 和 `docker` 检查通过。

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
