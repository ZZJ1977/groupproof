# GroupProof

GroupProof 是一个面向课程小组项目的协作与治理平台。平台围绕“任务、证据、验收、贡献”组织项目过程，目标是让学生、组长、教师、助教和管理员在同一套数据与权限模型下协作。

当前仓库是 **V1 Next.js 前端原型**。页面、导航、表单和主要交互已经完成，数据暂时由浏览器 Mock 服务和 `localStorage` 提供。真实登录、后端 API、数据库、文件存储、AI、GitHub/飞书同步和管理后台服务将在后续阶段接入。

## 当前状态

- 已完成 56 个设计页和对应路由。
- 已支持学生/组长、教师/助教、管理员三套演示角色。
- 已配置 Node.js 20、Next.js standalone 构建、Docker 和 GitHub Actions。
- 测试环境已部署到 Railway：[`groupproof-staging`](https://groupproof-staging-production.up.railway.app)。
- 生产环境已部署到 Railway：[`groupproof-production`](https://groupproof-production-production.up.railway.app)。
- `develop` 分支用于测试环境，`main` 分支用于生产环境。
- 当前 Mock 数据只保存在访问者自己的浏览器中，不同用户和 Railway 实例之间不会共享数据。

## 技术栈

- Next.js 15 App Router、React 19、TypeScript strict
- Tailwind CSS 4、Radix UI、Lucide React
- TanStack Query、React Hook Form、Zod
- Node.js 20，npm
- Docker 多阶段构建，Next.js standalone 运行模式
- GitHub Actions、Railway

## 环境要求

本地开发需要：

- Node.js `>=20 <25`
- npm 10 或兼容版本
- Docker Desktop（只有在本地构建容器时需要）

可以先确认版本：

```bash
node --version
npm --version
```

## 本地开发

第一次运行：

```bash
git clone git@github.com:ZZJ1977/groupproof.git
cd groupproof
npm ci
cp .env.example .env.local
npm run dev
```

打开 <http://localhost:3000>。页面右上角的演示角色选择器可以切换学生、组长、教师、助教和管理员视图。

开发服务器默认使用 Mock 数据，因此当前不需要启动数据库或后端服务。修改代码后 Next.js 会自动刷新页面。

## 环境变量

变量模板见 [`.env.example`](./.env.example)。当前前端主要使用以下变量：

```env
NEXT_PUBLIC_APP_ENV=development
NEXT_PUBLIC_ENABLE_MOCKS=true
NEXT_PUBLIC_API_BASE_URL=http://localhost:8000
API_INTERNAL_URL=http://localhost:8000
NEXT_PUBLIC_ADMIN_URL=http://localhost:3002
```

`NEXT_PUBLIC_` 开头的变量会进入浏览器包，只能放公开地址、环境名称和功能开关。数据库连接串、JWT 密钥、OAuth secret、对象存储密钥、AI 密钥和 Railway token 不得提交到 Git，应放在本地 `.env.local`、Railway Variables 或 GitHub Secrets 中。

接入真实 API 后，测试环境将 `NEXT_PUBLIC_ENABLE_MOCKS` 改为 `false`，并将 `NEXT_PUBLIC_API_BASE_URL` 指向 API 服务域名。

## 本地质量检查

提交代码前执行：

```bash
npm run lint
npm run typecheck
npm run check:routes
npm run build
```

其中：

- `lint` 检查 ESLint 规则。
- `typecheck` 执行 TypeScript 类型检查。
- `check:routes` 核对实施计划中的 56 个页面和实际路由映射。
- `build` 生成生产构建，并验证 Next.js standalone 输出。

如果本地已经启动开发服务器，可以额外检查所有页面的 HTTP 状态：

```bash
CHECK_HTTP=1 npm run check:routes
```

该命令会访问全部 56 个设计页，要求每个页面返回 HTTP 200。

## 生产构建与本地启动

使用普通 Next.js 生产服务器：

```bash
npm run build
npm run start
```

使用和 Railway 相同的 standalone 服务器：

```bash
npm run build
HOSTNAME=0.0.0.0 PORT=3000 npm run start:standalone
```

健康检查地址为 <http://localhost:3000/healthz>，正常响应如下：

```json
{"status":"ok"}
```

## Docker

仓库中的 [`Dockerfile`](./Dockerfile) 使用多阶段构建：

1. 使用 Node.js 20 安装锁定依赖。
2. 执行 `npm run build` 生成 standalone 包。
3. 使用非 root 用户运行最小化生产镜像。
4. 使用 Railway 注入的 `$PORT` 启动服务，并执行 `/healthz` 健康检查。

构建并运行镜像：

```bash
docker build -t groupproof-web:local .
docker run --rm --name groupproof-web \
  --env-file .env.local \
  -p 3000:3000 \
  groupproof-web:local
```

如果还没有 `.env.local`，可以先执行 `cp .env.example .env.local`。容器启动后检查：

```bash
curl --fail http://localhost:3000/healthz
curl --fail http://localhost:3000/
```

## 测试环境与生产环境

测试和生产使用两个独立的 Railway 项目，避免测试数据、密钥和部署互相影响：

| 环境 | Git 分支 | Railway 项目 | 用途 |
| --- | --- | --- | --- |
| 测试 | `develop` | `groupproof-staging` | 联调、验收、演示 |
| 生产 | `main` | `groupproof-production` | 真实用户使用 |

当前 `groupproof-staging` 已在 `zzj1977's Projects` 工作区运行，并连接 `develop` 分支。测试地址为：

<https://groupproof-staging-production.up.railway.app>

当前测试和生产都运行前端原型，数据仍由 Mock 层提供。后端、管理后台、数据库迁移和真实鉴权完成后，生产环境才具备正式对外开放条件。测试和生产必须使用不同的 PostgreSQL、Redis、对象存储桶和 OAuth 回调地址。

## Railway 部署

Railway 服务根目录保持在仓库根目录，平台会自动识别 `Dockerfile`。服务配置建议如下：

- 构建方式：Dockerfile
- Dockerfile 路径：`/Dockerfile`
- 健康检查：`/healthz`
- 测试分支：`develop`
- 生产分支：`main`

服务变量示例：

```env
NEXT_PUBLIC_APP_ENV=staging       # 生产改为 production
NEXT_PUBLIC_ENABLE_MOCKS=true     # 接入真实 API 后改为 false
NEXT_PUBLIC_API_BASE_URL=https://<api-domain>
API_INTERNAL_URL=http://api:8000
NEXT_PUBLIC_ADMIN_URL=https://<admin-domain>
```

Railway 自动部署和 GitHub Actions 部署应选择一种，不能同时启用，否则同一次推送可能产生两次部署。当前测试环境使用 Railway 的 GitHub 集成跟踪 `develop`；GitHub Actions 负责质量检查和 Docker 冒烟测试。

如果改用 Actions 门禁部署：

1. 在 GitHub 创建 `staging` 和 `production` Environments。
2. 在对应 Environment 中配置 `RAILWAY_TOKEN` secret 和 `RAILWAY_SERVICE_ID` variable。
3. 将仓库变量 `RAILWAY_DEPLOY_STAGING` 或 `RAILWAY_DEPLOY_PRODUCTION` 设置为 `true`。
4. 关闭对应 Railway 服务的自动 GitHub 部署，避免重复发布。

更完整的服务边界和环境策略见 [`docs/DEPLOYMENT.md`](./docs/DEPLOYMENT.md)。

## CI/CD

工作流文件为 [`.github/workflows/ci-cd.yml`](./.github/workflows/ci-cd.yml)，在 `develop` 或 `main` 推送时执行：

1. 安装锁定依赖。
2. 执行 lint、TypeScript 检查和路由映射检查。
3. 构建生产版本并启动 standalone 服务。
4. 检查首页、健康检查和全部 56 个页面。
5. 构建 Docker 镜像并验证健康检查和静态资源。
6. 按配置选择是否部署 Railway。

发布流程：

```text
功能分支本地测试 → 推送 develop → CI/CD 测试环境 → 验收通过 → 推送 main → CI/CD 生产环境
```

`develop` 的每次推送都会先经过质量检查和 Docker 检查，然后部署测试环境。测试环境确认通过后，再将 `develop` 的内容同步到 `main` 并推送；`main` 的检查通过后才发布生产环境。`main` 只允许负责人推送，避免未经测试的代码进入生产。

## 组员协作

仓库当前是私有仓库。你需要先在 GitHub 打开仓库的 **Settings → Collaborators → Add people**，邀请组员的 GitHub 账号，并给普通开发成员 `Write` 权限。只有项目负责人保留 `Admin` 权限，避免误删仓库、分支或环境配置。

组员接受邀请后，在自己的电脑执行：

```bash
git clone git@github.com:ZZJ1977/groupproof.git
cd groupproof
npm ci
cp .env.example .env.local
npm run dev
```

然后打开 <http://localhost:3000>。`.env.local` 只用于本机，不要提交；需要新增变量时先更新 [`.env.example`](./.env.example)，让所有成员使用同一份变量名。

每个人都从 `develop` 创建自己的功能分支，先在本地完成开发和检查：

```bash
git fetch origin
git switch develop
git pull --ff-only origin develop
git switch -c feat/task-evidence
```

分支名可以使用 `feat/功能名`、`fix/问题名` 或 `chore/维护内容`。完成开发后，先在本地执行：

```bash
npm run lint
npm run typecheck
npm run check:routes
npm run build
```

提交功能分支：

```bash
git add .
git commit -m "feat: add task evidence workflow"
git push --set-upstream origin feat/task-evidence
```

本地检查通过后，把功能分支合入 `develop` 并推送，触发测试环境 CI/CD：

```bash
git switch develop
git pull --ff-only origin develop
git merge --no-ff feat/task-evidence -m "merge: task evidence workflow"
git push origin develop
```

等待 GitHub Actions 的 `quality`、`docker` 检查和 Railway 测试部署全部成功，在测试环境完成验收。验收通过后，由负责人把测试分支同步到生产分支：

```bash
git switch main
git pull --ff-only origin main
git merge --ff-only origin/develop
git push origin main
```

这样 `main` 只接收已经在 `develop` 测试环境验证过的代码。

开始新任务前同步最新代码：

```bash
git switch develop
git pull --ff-only origin develop
git switch feat/task-evidence
git rebase origin/develop
```

发生冲突时先解决冲突，再运行全部检查。不要提交 `.env.local`、数据库密码、OAuth secret、AI key 或 Railway token；这些值只能放在本机环境、Railway Variables 或 GitHub Secrets 中。

## 项目开发计划

### 阶段一：V1 前端原型（当前已完成）

- 完成 56 个页面、角色导航和响应式布局。
- 完成课程、小组、项目、任务、里程碑、证据、验收和贡献视图。
- 完成教师端和 Admin 端的演示页面。
- 使用 Mock Adapter 保持领域模型、查询和变更契约，方便后续替换真实 API。
- 完成 Docker、CI/CD 和 Railway 测试环境。

### 阶段二：后端基础能力

- 使用 FastAPI 实现登录、学校邮箱验证、角色和权限校验。
- 使用 PostgreSQL 持久化课程、小组、项目、任务、证据、验收、贡献和审计日志。
- 增加并发版本检查、业务状态机和服务端权限控制。
- 将前端 Mock Adapter 替换为真实 API Adapter。

### 阶段三：文件、异步任务和管理后台

- 接入对象存储，支持文件上传、访问控制和版本记录。
- 使用 Redis 和 Worker 处理 AI 分析、报告导出、同步任务和 SSE 进度推送。
- 建立独立管理后台，提供用户、教师审核、课程、系统日志、AI 使用和异常访问管理。

### 阶段四：第三方集成

- Google OAuth 和真实学校身份体系。
- GitHub 仓库、Commit、PR、CI 同步。
- 飞书协作记录同步。
- AI 需求分析、任务辅助和逐项验收。
- PDF、DOCX 报告生成和下载。

### 阶段五：生产化

- 已创建 `groupproof-production` Railway 项目，并连接 `main` 分支。
- 分离测试和生产数据库、缓存、存储桶及密钥。
- 关闭生产环境 Mock，执行完整验收后再开放真实用户。

## 目录结构

```text
app/                         Next.js App Router 入口、布局和健康检查
components/                 工作区壳层与通用 UI
features/core/              登录、首页、通知和个人动态
features/project-core/      项目、需求、任务、里程碑、证据和验收
features/project-support/   GitHub、协作、文件、贡献、报告和项目设置
features/course/            课程和小组工作流
features/governance/        教师端与 Admin 演示页面
lib/api/                    Mock 服务适配器
lib/                        路由、工作区状态和工具函数
mocks/                       关联的演示种子数据
scripts/                    路由检查脚本
types/                      领域类型
public/                     静态资源
```

后端和管理后台开始开发后，建议逐步扩展为：

```text
apps/web/                    当前用户端
apps/admin/                  管理后台
services/api/                FastAPI API
services/worker/             异步任务消费者
packages/domain/             前后端共享契约与类型
infra/                       Compose、数据库迁移和运维脚本
```

## 当前限制

- 登录、邮箱验证码、OAuth 和权限目前是前端演示逻辑。
- 数据只保存在当前浏览器的 `localStorage` 中，不是共享数据。
- AI、GitHub、飞书、文件上传、报告导出和审批目前使用 Mock 实现。
- 真实 API、数据库、对象存储、Redis、Worker 和生产管理后台尚未接入。

详细的前端交付状态见 [`FRONTEND_STATUS.md`](./FRONTEND_STATUS.md)，页面与路由计划见 [`FRONTEND_IMPLEMENTATION_PLAN.md`](./FRONTEND_IMPLEMENTATION_PLAN.md)。
