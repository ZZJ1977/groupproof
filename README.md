# GroupProof

GroupProof 是面向高校课程项目协作与过程化考核的全栈教学管理平台，围绕 **可核验证据链、人工确认闭环的 AI 辅助验收、教师与学生工作台实时互通** 构建，覆盖三类角色端：

- **学生工作台 (`student/`)**：独立项目与课程项目双轨协作，支持独立项目一键「移入课程」并同步同课程队友与小组；提供需求基线冻结、任务树/看板/列表统一视图、GitHub / 飞书协作同步、证据中心、AI 验收（人工确认必经）及 7 章节报告生成导出。
- **教师 5-Hub 工作台 (`teacher/`)**：采用独立作用域主题与可折叠侧边栏，将原 12 个课程子页整合为 **概览 / 组队与名单 / 审批与申诉 / 项目与报告 / 课程设置** 5 大中心（兼容全部历史 URL），内置 `Cmd/Ctrl+K` 快速跳转、花名册抽屉与跨班仪表盘。
- **管理员治理控制台 (`admin/`)**：用户与身份目录、教师入驻审核、课程治理、操作审计日志、OpenRouter AI 场景用量统计与环境切换。

## 技术栈与顶层目录

- **前端**：Next.js 15 App Router · React 19 · TypeScript · Tailwind CSS v4 · Radix UI · TanStack Query · next-intl（简/繁/英）
- **后端与存储**：FastAPI · SQLAlchemy 2 · Alembic (`0047`) · PostgreSQL (`pgvector`) · Redis · Celery · GitHub App / 飞书 / OpenRouter AI

```text
app/              Next.js App Router 路由、全局样式与 /api/v1 同源代理
student/          学生工作台（课程、项目、执行、评审与 API 客户端）
teacher/          教师 5-Hub 工作台（页面、组件、图表、权限 Hook 与 API 客户端）
admin/            管理员治理控制台（仪表盘、身份/治理页面与客户端）
shared/           跨角色共享壳层、UI 控件、认证、首页/收件箱、i18n 与兼容层
services/         统一 FastAPI 后端 (services/api) 与 Celery 异步 Worker (services/worker)
packages/domain/  后端导出的 OpenAPI 快照 (openapi.json) 与生成的 TS 类型
e2e/ · scripts/   Playwright 端到端测试、工程契约校验与 Railway 部署脚本
```

完整目录树、核心领域不变量与 OpenAPI 同步流程见 [开发与架构设计](docs/guide/ARCHITECTURE.md)。

## 快速开始

需要 Node.js 20–24、Python 3.12（`services/api/.venv`）与 Docker：

```bash
npm ci
cp .env.example .env       # 按需填写本地凭据；严禁使用 source .env
npm run dev                # 自动拉起后端容器 + alembic 迁移，启动 Web (3000) 与 API (8000)
```

详细环境配置、管理员初始化、第三方集成变量、全量测试命令与 Railway 部署说明见 [本地开发、测试与部署指引](docs/guide/LOCAL_AND_DEPLOY.md)。

## 文档导航

| 文档 | 内容说明 |
| --- | --- |
| [开发与架构设计](docs/guide/ARCHITECTURE.md) | 技术栈、完整目录结构、核心领域与状态机不变量、OpenAPI 契约同步 |
| [本地开发、测试与部署指引](docs/guide/LOCAL_AND_DEPLOY.md) | 本地启动、环境变量、第三方集成、前后端与 Playwright 校验命令、Railway 部署 |
| [前端实现状态](FRONTEND_STATUS.md) | 各模块真实接口接入状态、限制与阶段交付记录 |
| [项目协作规范](AGENTS.md) | 研发协作流程、目录职责与 AI 编码助手约束 |
| [前端页面地图](docs/architecture/FRONTEND_IMPLEMENTATION_PLAN.md) | 全站路由与 56 个设计页 + 教师/管理端扩展页映射 |
| [系统技术方案](docs/architecture/TECHNICAL_PLAN.md) | 系统架构设计与后端模块边界说明 |
| [部署架构文档](docs/architecture/DEPLOYMENT.md) | Staging / Production 环境与基础设施部署参考 |
| [并发压力测试报告](docs/testing/STRESS_TEST_REPORT.md) | 本地 PG16 读写/锁竞争与 Railway Staging 公网并发实测数据及瓶颈分析 |
