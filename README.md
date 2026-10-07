# GroupProof

面向课程小组项目的协作与治理平台，围绕任务、证据、验收和贡献组织项目过程。

当前仓库是 **V1 Next.js 前端原型**。页面、导航、表单和主要交互已经完成；数据暂时由浏览器 Mock 服务和 localStorage 提供。

## 当前状态

| 项目 | 状态 |
| --- | --- |
| Web 前端 | 已完成 56 个设计页和对应路由 |
| 演示角色 | Student、Leader、Teacher、TA、Admin |
| Docker | 已配置 Node 20 standalone 多阶段构建 |
| CI/CD | GitHub Actions 已配置 lint、类型、路由、构建和 Docker 检查 |
| 测试环境 | Railway develop 分支，已部署 |
| 生产环境 | Railway main 分支，已部署前端原型 |
| 后端和数据服务 | 按技术方案逐步接入 |

## 快速开始

需要 Node.js >=20 <25 和 npm：

~~~bash
git clone git@github.com:ZZJ1977/groupproof.git
cd groupproof
npm ci
cp .env.example .env.local
npm run dev
~~~

打开 http://localhost:3000。当前开发模式使用 Mock 数据，不需要启动后端、数据库或 Redis。

提交代码前执行：

~~~bash
npm run lint
npm run typecheck
npm run check:routes
npm run build
~~~

完整的本地开发、Docker 和组员协作命令见 [开发与发布流程](./docs/DEVELOPMENT.md)。

## 技术选型摘要

- 产品：Web-only
- 前端：Next.js、Tailwind CSS、shadcn/ui
- 后端：FastAPI/Python，采用 Modular Monolith
- 数据：PostgreSQL、pgvector
- 文件：Supabase Storage
- 异步：Redis、Celery
- 实时：SSE
- AI：第三方 LLM API + Provider Adapter
- 集成：GitHub App、飞书 Open API
- 认证：Google Login + MUST 邮箱验证
- 权限：Contextual RBAC
- 部署：Railway
- 监控：Sentry
- 测试：pytest、Playwright

完整技术表、系统分层、开发阶段和当前限制见 [技术方案与开发计划](./docs/TECHNICAL_PLAN.md)。

## 测试与生产

| 环境 | 分支 | 地址 |
| --- | --- | --- |
| Staging | develop | [groupproof-staging](https://groupproof-staging-production.up.railway.app) |
| Production | main | [groupproof-production](https://groupproof-production-production.up.railway.app) |

发布顺序固定为：

~~~text
功能分支本地测试 → 推送 develop → CI/CD 和 Staging 验收 → 推送 main → Production
~~~

Railway 服务拓扑、环境变量、服务命名和环境隔离见 [部署基线](./docs/DEPLOYMENT.md)。

## 文档分层

| 文档 | 内容 |
| --- | --- |
| 本 README | 项目入口、当前状态和最短启动路径 |
| [开发与发布流程](./docs/DEVELOPMENT.md) | 本地开发、环境变量、质量检查、Docker、组员协作、测试到生产 |
| [技术方案与开发计划](./docs/TECHNICAL_PLAN.md) | 最终技术选型、系统分层、阶段计划、目录和限制 |
| [部署基线](./docs/DEPLOYMENT.md) | Railway Staging/Production、服务拓扑和部署约定 |
| [前端交付状态](./FRONTEND_STATUS.md) | 已完成页面、Mock 边界和待接入能力 |
| [页面实施计划](./FRONTEND_IMPLEMENTATION_PLAN.md) | 56 个页面与路由映射 |

## Docker 快速启动

~~~bash
docker build -t groupproof-web:local .
docker run --rm --env-file .env.local -p 3000:3000 groupproof-web:local
~~~

健康检查：

~~~bash
curl --fail http://localhost:3000/healthz
~~~

## 当前范围

登录、邮箱验证、OAuth、权限、AI、GitHub、飞书、文件上传、报告导出、数据库和管理后台仍是后续接入项。当前生产环境运行的是前端原型，正式开放真实用户前需要完成后端和数据服务接入。

