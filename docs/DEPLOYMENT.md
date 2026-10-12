# 部署基线

当前仓库包含 Next.js Web、`server/` 身份服务，以及 `services/api` 业务 API。它们应作为独立 Railway 服务部署；身份服务和业务 API 必须使用不同的数据库，避免同名账户表及迁移互相影响。

## 环境策略

使用两个 Railway 项目隔离测试和生产数据：

| 环境 | Git 分支 | Railway 项目 | 用途 |
| --- | --- | --- | --- |
| 测试 | `develop` | `groupproof-staging` | 联调、验收、演示 |
| 生产 | `main` | `groupproof-production` | 面向真实用户 |

`groupproof-staging` 和 `groupproof-production` 已分别创建 Web、业务 API 和 PostgreSQL 服务。身份服务使用本仓库 `server/`，应在两个 Railway 项目分别新建 `identity` 服务；每个环境的身份库都必须独立于同项目的业务 API 数据库。Staging 代码通过 PR 合入 `develop` 后部署，生产代码通过 PR 合入 `main` 后部署。测试和生产使用不同的数据库、Redis、对象存储桶、OAuth 回调和邮件 API 密钥。

每个项目建议使用以下服务名：

| 服务 | 当前状态 | 说明 |
| --- | --- | --- |
| `web` | 已支持 | 当前仓库的 Next.js 用户端 |
| `identity` | 需在 Staging 和 Production 各创建一个 | 本仓库 `server/`；身份、会话、注册和登录邮箱验证 |
| `api` | 已有业务 API 服务 | `services/api`；必须与 `identity` 使用不同的数据库 |
| `admin` | 预留 | 管理后台；可在同一仓库的 `apps/admin` 中维护 |
| `worker` | Staging 基础设施已运行，A2 代码待 PR；Production 待 `main` 合并 | Celery 任务消费者；两套 Railway 服务均已绑定各自 Redis |
| `postgres` | 已创建 | Railway 托管 PostgreSQL/pgvector；每个环境独立 |
| `redis` | 已创建 | Celery/SSE 的 Redis 协议使用项目内 Redis；测试和生产完全隔离 |

不要把前端、API 和管理后台强行塞进同一个容器。它们应独立部署、独立扩缩容，并通过环境变量传递地址。

## Web 与身份服务

`web` 服务根目录保持在仓库根目录，平台使用根目录 `Dockerfile`。`identity` 服务由 CI 把 `server/` 作为上传根目录单独部署，使用该目录内的 `Dockerfile`；Railway 服务的 Root Directory 保持空（仓库根），Dockerfile Path 使用默认值。容器启动时执行 Alembic 迁移，并监听 Railway 注入的 `$PORT`。身份服务健康检查路径设为 `/readyz`。

## A1 本地全套环境

仓库根目录的 `docker-compose.yml` 可以同时启动 Web、FastAPI API、worker、PostgreSQL/pgvector 和 Redis。默认端口分别为 3000、8000、5432 和 6379；使用 `.env` 中的 `*_PORT` 变量可以覆盖宿主机端口。

```bash
cp .env.example .env
docker compose up --build
```

在 Railway 的 `web` 服务中配置：

```text
NEXT_PUBLIC_APP_ENV=staging       # 生产改为 production
NEXT_PUBLIC_ENABLE_MOCKS=true     # 业务 API 验收后再改为 false
NEXT_PUBLIC_API_BASE_URL=https://<business-api-domain>
API_INTERNAL_URL=http://${{identity.RAILWAY_PRIVATE_DOMAIN}}:8000
NEXT_PUBLIC_ADMIN_URL=https://<admin-domain>
```

`API_INTERNAL_URL` 指向同一 Railway 项目内 `identity` 服务的私网地址；浏览器仍只访问 Web 同源 `/api/v1/*`。不要将身份服务公开给浏览器直连。

`NEXT_PUBLIC_` 变量会进入浏览器包，只能放公开地址和功能开关。JWT 密钥、数据库连接串、OAuth secret、对象存储密钥和 Railway token 只能放 Railway Variables 或 GitHub Secrets，不能提交到仓库。

业务 API 和 worker 在两个 Railway 项目中分别配置以下变量；`${{ ... }}` 是 Railway 项目内的服务引用，不要把解析后的密码写入仓库：

```text
APP_ENV=staging                 # Production 项目使用 production
DATABASE_URL=${{Postgres.DATABASE_URL}}
DATABASE_TIMEZONE=Asia/Shanghai
REDIS_URL=${{Redis.REDIS_URL}}
```

业务 API 另外设置 `PORT=8000`，worker 使用 `services/worker` 作为根目录并运行 Celery consumer。

身份服务在每个 Railway 项目设置以下变量：

```text
APP_MODE=real
APP_ORIGIN=https://<当前环境的-web-domain>
DATABASE_URL=<专用于身份服务的 PostgreSQL 数据库 URL>
EMAIL_CHALLENGE_HMAC_KEY=<每个环境独立的随机密钥>
AUTH_GOOGLE_ENABLED=false                 # 配好该环境的 Google OAuth 后再启用
AUTH_PASSWORD_ENABLED=true
AUTH_EMAIL_SIGNUP_ENABLED=true
AUTH_PASSWORD_RESET_ENABLED=true
MAIL_MODE=resend
RESEND_API_KEY=<当前环境的 Resend API key>
MAIL_FROM=GroupProof <noreply@已验证域名>
PORT=8000
```

Railway Hobby 禁止 SMTP 出站；Resend 使用 HTTPS API，因此不需要开通 SMTP。先在 Resend 验证发件域名，再分别生成 Staging 和 Production API key；只将密钥存入对应 Railway `identity` 服务的 Variables。Railway 对邮件出站限制的说明见[官方文档](https://docs.railway.com/networking/outbound-networking#email-delivery)，Resend API 格式见[官方邮件 API 文档](https://resend.com/docs/api-reference/emails/send-email)。

身份数据库必须是与 `services/api` 分开的数据库，即使它们运行在同一个 PostgreSQL 服务中也要使用不同的数据库名。`server/` 和 `services/api/` 有各自的迁移、`alembic_version` 及同名账户表；不要让身份服务对现有业务 API 数据库执行迁移。Staging 与 Production 也不能共用同一个身份数据库。

## CI/CD 触发方式

GitHub Actions 在目标分支的 PR 和推送 `develop` 或 `main` 时执行前端质量、Python 后端检查、路由检查、生产构建和 Docker 冒烟测试；全部通过后才执行对应环境的 Railway 部署。Railway 服务自身的 GitHub 自动部署连接已断开，避免绕过 CI 或重复部署。

GitHub 仓库 Actions Secret：`RAILWAY_TOKEN`，存放有对应工作区权限的 Railway API Token。工作流将其映射为 Railway CLI 使用的 `RAILWAY_API_TOKEN`。GitHub Environment `staging` 和 `production` 各自设置 `RAILWAY_PROJECT_ID`、`RAILWAY_SERVICE_ID`（Web 服务）、`RAILWAY_IDENTITY_SERVICE_ID`（身份服务），避免部署到错误项目或服务。工作流要求两个服务 ID 都已配置，先上传 `server/` 部署身份服务，再上传仓库根目录部署 Web。`RAILWAY_ENVIRONMENT` 可按项目单独设置；目前两个独立 Railway 项目内部的环境名都为 `production`，工作流默认使用这个值。GitHub Environment 的 `staging`/`production` 名称与 Railway 项目内环境名不是同一个配置项。

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
