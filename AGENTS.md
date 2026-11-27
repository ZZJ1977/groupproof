# GroupProof 项目协作规范

## 适用范围与工作原则

本文件适用于本仓库的所有目录、分支及在这些目录中工作的 AI 编码助手。开始任务时先读取本文件与任务相关的现有文档，依据最新代码和用户要求推进工作。

- 按“产品需求 → 页面结构 → 设计体系 → 代码实现 → 体验验证”的顺序建立依据，使界面、交互与业务目标一致。
- UX Rules 贯穿需求、线框、组件、编码和验收；Business Logic 从需求阶段开始定义，在实现阶段落实。
- 按改动范围裁剪流程：新功能或大幅改版走完整设计/契约/验证环节；局部修复复用已有依据，补充受影响的测试与文档。
- 复用已有设计令牌、共享组件、OpenAPI 契约与目录结构；将重要假设、范围变化与验证结果同步到文档。
- 遇到缺失且影响结果的信息时，先查阅现有代码与文档；仍无法判断时询问用户，同时推进不依赖该信息的工作。

## 产品到实现的主流程

```text
PRODUCT
  │
  ▼
Product Requirement
  │
  ▼
Information Architecture
  │
  ▼
Screen Map
  │
  ▼
Wireframe
  │
  ├──────────────────┐
  ▼                  ▼
Design Skill       UX Rules ───────────────┐
  │                                      │
  ▼                                      │
Design Tokens                            │
  │                                      │
  ▼                                      │
UI Components ◀──────────────────────────┤
  │                                      │
  ├── shadcn / Lucian UI / Custom        │
  │                                      │
  ▼                                      │
AI Coding ◀──────────────────────────────┤
  │                                      │
  ▼                                      │
Business Logic                           │
  │                                      │
  ▼                                      ▼
Responsive / A11y / UX Review ────────────┘
  │
  └── 将发现的问题反馈到相关设计和实现阶段
```

## 各阶段的目标与完成标准

1. **Product Requirement**：明确目标用户、业务对象、角色权限（Student / Leader / Teacher / TA / Admin）、核心操作、异常路径与可验证验收标准。
2. **Information Architecture & Screen Map**：按角色任务组织导航与路由；同步维护 [前端页面地图](docs/architecture/FRONTEND_IMPLEMENTATION_PLAN.md) 与 `shared/lib/routes.ts`，保持 56 个核心设计页与扩展页（`57–63`）的路由与门禁一致。
3. **Wireframe & UX Rules**：覆盖加载、空数据、错误、成功、无权限与禁用态；支持键盘操作、可见焦点、减少动效（`prefers-reduced-motion: reduce`）与明确反馈；禁止重复提交与无反馈写操作。
4. **Design Tokens & UI Components**：优先复用 `app/globals.css`、`shared/styles/lux-*.css`、`shared/components/ui/` 与 `shared/components/lux/`；避免在不同页面为同一语义重复定义硬编码色值。
5. **AI Coding & Business Logic**：遵循服务端 Contextual RBAC、乐观锁 `lock_version` 与 `Idempotency-Key`；页面层通过角色 `api/` 客户端和 `/api/v1/*` 代理调用统一 FastAPI 后端，不得在前端散落伪造状态或绕过服务端校验。
6. **Responsive / A11y / UX Review**：检查桌面与窄屏（如 `1440px` / `1024px` / `768px` / `375px`）、焦点管理、对比度与跨视图数据一致性，使用真实测试结果记录发现并复查。

## 当前系统基线与上线状态（2026-11-27）

- **全栈已上线（Staging / Production / Admin Console）**：
  - Staging（`develop`）：<https://groupproof-staging-production.up.railway.app>
  - Production（`main`）：<https://groupproof-production-production.up.railway.app>
  - Admin Console（`admin-backend`，支持 Staging/Production 双环境切换）：<https://web-production-650d4574.up.railway.app/admin>
- **统一后端与数据库**：唯一后端为 `services/api/`（FastAPI + SQLAlchemy 2 + Alembic 头 **`0047`**），早期 `server/` 目录已退役移除；Railway 托管 **PostgreSQL 18.6**（`pgvector`、`pgcrypto`）+ Redis + Celery Worker（`report-worker`、`risk-scheduler`、`services/worker/`）。
- **100% 真实认证与集成**：Argon2id 密码认证、HttpOnly Session Cookie + CSRF、Brevo / Resend / SMTP 学校邮箱 OTP、Google OIDC 登录与账号关联、GitHub App & OAuth 多分支同步、飞书机器人协作洞察、OpenRouter 双模型 AI（`deepseek/deepseek-v3.2` + `google/gemini-2.5-flash` + `a_ai_usage_events`）、Supabase Storage + PostgreSQL LOB 回退、贡献分析 v2（`formal-task-weight-cross-task-equal-split-v2`，5 维呈现，提交数与飞书聊天 0% 权重）以及独立项目移入课程（`POST /api/v1/projects/{id}/attach-course`）均已上线。
- **阶段记录入口**：架构与运行指引见 [README.md](README.md)、[开发与架构设计](docs/guide/ARCHITECTURE.md)、[本地开发、测试与部署指引](docs/guide/LOCAL_AND_DEPLOY.md)；交付状态与客观限制见 [FRONTEND_STATUS.md](FRONTEND_STATUS.md)；历史分阶段索引见 [docs/development-stages/README.md](docs/development-stages/README.md)；压测与 AI 成本实测见 [STRESS_TEST_REPORT.md](docs/testing/STRESS_TEST_REPORT.md)。

## GroupProof 工程与运行约定

### 目录职责

- `app/`：Next.js 15 App Router 路由入口、全局样式（`globals.css`）与 `/api/v1/*` 同源运行时代理。
- `student/`：学生工作台（课程、独立/课程项目、执行、评审、API 客户端与导航状态）。
- `teacher/`：教师 5-Hub 工作台（页面、组件、图表、助教细粒度权限 Hook 与 API 客户端）。
- `admin/`：管理员治理控制台（双环境切换器、身份与平台治理页面及 API 客户端）。
- `shared/`：跨角色基础组件与壳层（`shared/components/`、`shared/components/ui/`、`shared/components/lux/`）、认证与账户中心（`shared/auth/`、`shared/auth/lux/`）、首页/动态/通知收件箱（`shared/daily-inbox/`）、Lucian UI 样式（`shared/styles/`）、三语目录（`shared/i18n/`）、路由与共享客户端（`shared/lib/`）、领域类型（`shared/types/`），以及**仅用于隔离测试与静态断言**的 `shared/legacy-mock/`（Staging 与 Production 强制关闭）。
- `services/`：统一 FastAPI 后端（`services/api/`，含 `app/auth`、`app/modules/{a,b,c,d}`、`migrations/versions/` `0001–0047`、`tests/`）与异步 Worker（`services/worker/`）。
- `packages/domain/`：后端导出的 OpenAPI 快照（`openapi.json`）与生成的 TypeScript 类型（`api.generated.ts`）。
- `e2e/` 与 `scripts/`：Playwright 端到端测试、契约校验脚本与 Railway 部署脚本。

### 核心业务不变量（不可破坏）

- **权限边界**：团队共同编辑并确认责任，组长推进发布；同课程其他小组仅只读课程公开项目的总览 DTO；助教默认只读，由所属课程教师按操作细粒度授权；所有写权限最终由 FastAPI 服务端校验。
- **版本与证据**：正式版本与草稿分离，成员确认严格绑定版本号；任务树/看板/列表共享同一 Task 数据；进度 100% 不自动提交；AI 验收通过仍需人工确认；正式证据按规则撤回或作废并在同事务失效关联验收。
- **贡献核算 v2**：正式贡献比例仅基于人工确认的任务权重与跨任务分工核算；代码提交次数与飞书群聊讨论权重为 `0%`，仅作过程参考。

### 本地运行与测试避坑约定

- **严禁执行 `source .env`**：bash/zsh 会吞掉值中的反斜杠（例如 `STUDENT_ID_PATTERN` 中的 `\S{4,20}` 会被破坏为 `S{4,20}`，导致学号校验误拒）。启动后端请始终使用 `npm run dev`、`scripts/dev-backend.sh` 或直接运行 `uvicorn app.main:app`（Pydantic 自动读取仓库根目录 `.env`）。
- **后端测试环境**：完整 `pytest` 需运行本地 PostgreSQL（`docker compose up -d postgres redis`）并设置 `DATABASE_URL`、`C_TEST_DATABASE_URL`、`C_EXECUTION_TEST_DATABASE_URL`、`B_TEST_DATABASE_URL`。
- **本地邮件捕获**：`MAIL_MODE=capture` 下的验证码写入 PostgreSQL `email_outbox` 表。
- **OpenAPI 契约同步**：修改 `services/api` 路由或 Pydantic Schema 后，必须运行 `cd services/api && PYTHONPATH=. python scripts/export_openapi.py` 与根目录 `npm run api:generate`，CI 会强制检查无漂移。
- **路由表守卫**：修改页面或导航时须同步 `shared/lib/routes.ts` 与 `docs/architecture/FRONTEND_IMPLEMENTATION_PLAN.md`（保留 01–56 行结构），并运行 `npm run check:routes`（启动服务后可加 `CHECK_HTTP=1`）。
- **常规工程检查**：前端执行 `npm run lint`、`npm run typecheck`、`npm run build`、`npm run check:routes`、`npm run check:i18n`；后端执行 `ruff format --check`、`ruff check`、`alembic check`、`pytest -q`。纯文档改动核对事实准确、相对链接有效与 `npm run check:routes` 即可。

## 分支与聊天共享规则

- 仓库维护 7 条长期分支：`A_task`（卓子杰/组长）、`B_task`（郑元泰）、`C_task`（杨凯景）、`D_task`（林星妤）、`admin-backend`、`develop`（Staging）、`main`（Production）。个人分支通过 PR 合入 `develop`（须通过 6 项 CI 并由组长审查），经 Staging 验收后同步 `main` 发布生产。
- 本文件纳入版本管理并放在仓库根目录，作为各分支可读取的项目规范。使用独立工作树或克隆时，确保不依赖其他工作树中的未提交文件。
- 更新共享规范或重要架构决策时须提交同步到相关分支，不要把约定仅留在某次聊天中。

读取范围参考：[OpenAI 官方 AGENTS.md 文档](https://learn.chatgpt.com/docs/agent-configuration/agents-md)。
