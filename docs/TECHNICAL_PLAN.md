# 技术方案与开发计划

## 最终技术选型

以下选型是 GroupProof V1 及后续完整系统的统一技术基线。当前仓库已经落地 Web 前端、Docker、GitHub Actions 和 Railway；后端、数据服务和第三方集成按此边界逐步接入。

| 层级 | 最终技术选型 | 用途 |
| --- | --- | --- |
| 产品形态 | **Web-only** | V1 只做 Web，不开发独立 App |
| 前端 | **Next.js + Tailwind CSS + shadcn/ui** | 学生端、教师端、Admin 后台 |
| 后端 | **FastAPI / Python** | REST API、业务逻辑、第三方集成和 AI 调用 |
| 后端架构 | **Modular Monolith** | 模块化单体，暂不上微服务 |
| 主数据库 | **PostgreSQL** | User、Course、Group、Task、Evidence、Review、Report 等业务数据 |
| 向量能力 | **pgvector** | AI 检索、语义匹配和 Evidence ↔ Task 关联 |
| 文件存储 | **Supabase Storage** | 文档、Evidence 文件和附件 |
| 异步任务 | **Redis + Celery** | AI 分析、GitHub/飞书同步、文档解析和报告生成 |
| 实时状态 | **SSE** | 推送 AI 分析完成、同步完成等状态 |
| AI | **第三方 LLM API + Provider Adapter** | 任务提取、Evidence 分析、验收和风险解释 |
| GitHub | **GitHub App + REST API + Webhook** | Commit、Pull Request、Diff、Changed Files 和 CI 证据 |
| 飞书 | **企业自建应用 + 飞书 Open API** | V1 只读同步项目群协作证据 |
| 认证 | **Google Login + MUST 邮箱验证** | 学生身份认证 |
| 权限 | **Contextual RBAC** | Student / Teacher / Admin 加课程和小组上下文权限 |
| CI/CD | **GitHub Actions** | 自动测试、构建和 Staging 部署 |
| 部署 | **Railway + Managed PostgreSQL** | 部署 Next.js、FastAPI、Celery 和 Redis |
| 监控 | **Sentry** | 前后端错误监控 |
| 测试 | **pytest + Playwright** | 后端单元/集成测试和前端/E2E 测试 |

## 系统分层

后端采用模块化单体，先保持一个 FastAPI 应用和清晰的领域模块：

~~~text
Web 层          Next.js 用户端、教师端、Admin
API 层          FastAPI REST API、SSE、认证中间件
业务层          User、Course、Group、Project、Task、Evidence、Review、Report
集成层          GitHub App、飞书 Open API、LLM Provider Adapter
任务层          Redis + Celery Worker
数据层          PostgreSQL + pgvector
文件层          Supabase Storage
运维层          Railway、GitHub Actions、Sentry
~~~

前端、API、管理后台和 Worker 作为独立 Railway 服务部署。模块化单体只限制后端的业务拆分方式，不把所有服务塞进一个容器。

## 项目开发计划

### 阶段一：V1 前端原型（已完成）

- 完成 56 个页面、角色导航和响应式布局。
- 完成课程、小组、项目、任务、里程碑、证据、验收和贡献视图。
- 完成教师端和 Admin 端演示页面。
- 使用 Mock Adapter 保持领域模型、查询和变更契约。
- 完成 Docker、CI/CD、Staging 和 Production 基础环境。

### 阶段二：后端基础能力

- 使用 FastAPI 实现登录、学校邮箱验证、角色和权限校验。
- 使用 PostgreSQL 持久化课程、小组、项目、任务、证据、验收、贡献和审计日志。
- 启用 pgvector，支持语义检索和 Evidence ↔ Task 关联。
- 增加并发版本检查、业务状态机和服务端权限控制。
- 将前端 Mock Adapter 替换为真实 API Adapter。

### 阶段三：文件、异步任务和管理后台

- 接入 Supabase Storage，支持文件上传、访问控制和版本记录。
- 使用 Redis 和 Celery 处理 AI 分析、报告导出、同步任务和文档解析。
- 使用 SSE 推送异步任务进度。
- 建立独立 Admin 服务，提供用户、教师审核、课程、系统日志、AI 使用和异常访问管理。

### 阶段四：第三方集成

- Google Login 和 MUST 邮箱验证。
- GitHub App、Commit/PR/Diff/Changed Files 和 CI 证据同步。
- 飞书企业自建应用的只读协作记录同步。
- LLM Provider Adapter、需求分析、任务辅助、Evidence 验收和风险解释。
- PDF、DOCX 报告生成和下载。

### 阶段五：生产化

- 测试和生产分别使用独立数据库、Redis、存储桶、OAuth 回调和密钥。
- 完成数据库迁移、备份、监控、日志、告警和回滚流程。
- 真实 API、认证和管理后台验收通过后，关闭生产环境 Mock。

## A1 目录边界

~~~text
apps/web/                    当前用户端的迁移入口
apps/admin/                  管理后台迁移入口
services/api/                FastAPI API 和按成员划分的模块
services/worker/             后台任务消费者和按成员划分的任务
packages/domain/             前后端共享契约与类型
infra/                       Compose、数据库迁移和运维脚本
~~~

当前根目录的 `app/`、`components/`、`features/`、`lib/`、`mocks/` 和 `types/` 仍是可部署的 Next.js Web 应用。A1 建立了 `services/api`、`services/worker`、`packages/domain` 和 `infra` 的边界；后端功能按 A/B/C/D 的模块目录开发。前端逐步迁移到 `apps/web` 时，保留根目录 Dockerfile 以避免影响现有部署。

## 当前限制

- 登录、邮箱验证码、OAuth 和权限目前是前端演示逻辑。
- 数据只保存在当前浏览器的 localStorage 中，不是共享数据。
- AI、GitHub、飞书、文件上传、报告导出和审批目前使用 Mock 实现。
- 真实 API、PostgreSQL、pgvector、Supabase Storage、Redis、Celery、SSE、Sentry 和生产管理后台尚未接入。
- A1 已将 pytest 接入后端骨架的 CI；Playwright 仍需在前端业务功能稳定后补充页面级测试。
