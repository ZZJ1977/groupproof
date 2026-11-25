# GroupProof

GroupProof 是面向高校课程项目协作与过程化考核的全栈教学管理平台，围绕「可核验证据驱动的团队贡献追踪、人工确认闭环的 AI 辅助验收、教师与学生工作台实时互通」构建，覆盖 **学生工作台、教师 5-Hub 工作台、管理员治理控制台** 三类角色端。

---

## 1. 项目介绍

### 解决的核心教学与协作痛点

传统课程小组项目通常只看期末汇报和静态文档，缺乏客观过程数据，容易出现分工不均、搭便车争议、进度失真及申诉无据可依的问题。GroupProof 通过以下机制建立可追溯的协作与考核闭环：

- **可核验的过程证据链**：自动同步 GitHub 多分支提交 / PR / CI 与飞书群讨论结论，配合文件版本与任务执行记录，将候选证据经规则采纳为正式证据，避免凭口头汇报分配贡献度。
- **AI 辅助验收 + 人工确认必经**：AI 可辅助进行需求拆解、验收标准核验与 7 章节论文式报告起草，但所有 AI 验收结果均须经过人工确认后才计入正式通过与完成态。
- **教师与学生工作台互通**：教师建班并生成邀请码，学生入班后可在班内组队立项，也可先创建独立项目、随后一键「移入课程」并自动同步同课程队友与小组，教师端总览、组队广场、项目监控与班级报告即时可见。

### 三大角色端核心能力

- **学生工作台 (`student/`)**
  - 独立项目与课程项目双轨协作；支持独立项目一键移入已加入课程（`POST /api/v1/projects/{project_id}/attach-course`），完整保留已有任务、需求、证据与集成绑定。
  - 需求收集、冲突裁决与基线冻结；任务树 / 看板 / 列表共享同一套任务数据。
  - GitHub 仓库绑定与统计、飞书群协作洞察、证据中心（候选/正式证据与撤回作废）、AI 验收与人工确认、成员贡献度可视化、7 章节报告编辑器与导出。
- **教师 5-Hub 工作台 (`teacher/`)**
  - 独立作用域视觉体系（`.gp-teacher-shell` + `GpThemeScopeProvider`）与可折叠侧边导航栏，不影响学生端与管理端。
  - 将原 12 个课程子页面收敛为 **概览 / 组队与名单 / 审批与申诉 / 项目与报告 / 课程设置** 5 大中心（所有历史 URL 保持挂载兼容）。
  - 提供 `Cmd/Ctrl+K` 全局快速跳转器、班级花名册与学生档案抽屉、待办审批与申诉裁决、公告与课程资料管理、助教细粒度授权及跨班仪表盘。
- **管理员治理控制台 (`admin/`)**
  - 平台概览、用户与身份目录、教师入驻申请审核、课程治理、操作审计日志、OpenRouter AI 场景用量与成本统计、跨项目访问申请审批及运行环境切换。

---

## 2. 开发与架构设计

### 技术栈

| 层级 | 技术选型与职责 |
| --- | --- |
| Web 前端 | Next.js 15 App Router、React 19、TypeScript、Tailwind CSS v4、Radix UI / shadcn 风格组件、TanStack Query、next-intl（简体中文 / 繁體中文 / English） |
| 统一后端 | FastAPI、SQLAlchemy 2、Alembic（迁移头 `0047`）、Pydantic v2、会话 Cookie + CSRF 校验、Google OIDC |
| 数据与异步 | PostgreSQL（含 `pgvector`）、Redis、Celery Worker（异步报告导出与定时风险扫描） |
| 外部集成 | GitHub App / OAuth、飞书开放平台机器人、OpenRouter AI、Resend / SMTP 邮件通道 |

### 仓库目录结构

```text
.
├── app/                     # Next.js App Router 路由入口、全局样式 (globals.css) 与 /api/v1 同源代理
├── student/                 # 学生工作台（api/ courses/ projects/ execution/ review/ ux/）
├── teacher/                 # 教师 5-Hub 工作台（api/ charts/ components/ hooks/ pages/）
├── admin/                   # 管理员治理控制台（api/ components/ lib/ pages/）
├── shared/                  # 跨角色共享模块
│   ├── components/          # WorkspaceShell、RouteDispatcher、通用组件与 ui/ 基础控件
│   ├── auth/                # 登录、注册资料补全、密码重置、账户中心与服务端会话校验
│   ├── daily-inbox/         # 首页概览、个人动态、通知与待处理收件箱
│   ├── i18n/                # next-intl 配置、三语 messages/ 与中文 UI 翻译目录 catalog/
│   ├── lib/                 # 路由表、导航上下文、API 基础客户端与工具函数
│   ├── types/               # 共享领域类型定义
│   └── legacy-mock/         # 隔离测试与历史演示模式兼容层（Staging/Production 强制关闭）
├── services/
│   ├── api/                 # 统一 FastAPI 认证与业务后端（auth + modules a/b/c/d + alembic + pytest）
│   └── worker/              # Celery 异步报告导出与风险调度 Worker
├── packages/domain/         # 后端导出的 OpenAPI 契约快照 (openapi.json) 与生成的 TS 类型 (api.generated.ts)
├── e2e/                     # Playwright 端到端测试套件（含教师工作台 t1–t5 套件）
├── scripts/                 # 路由/i18n/UI/权限契约检查、客户端生成与 Railway 部署脚本
└── docs/                    # 架构规划、开发阶段规格、运行手册与验收报告
```

> 基础设施边界：`app/`、`services/`、`packages/domain/`、`Dockerfile`、`docker-compose.yml`、`.github/` 及 `scripts/deploy-*.mjs` 保持原有路径稳定，确保 Railway Staging / Production 自动部署、Alembic 迁移与回滚零中断。

### 核心领域与状态机不变量

1. **正式版本与草稿分离**：课程规则、需求基线与任务计划均区分草稿与冻结/发布版本；成员确认绑定具体版本号，并发写操作通过 `lock_version` 与 `Idempotency-Key` 防止覆盖与重复提交。
2. **候选证据与正式证据分离**：GitHub / 飞书 / 文件版本先作为候选证据采集，经采纳进入正式证据并可按规则撤回或作废；外部集成未配置时仅明确展示不可用状态，不生成模拟数据。
3. **AI 验收不绕过人工确认**：任务树、看板与列表共享同一份任务数据；任务进度达到 100% 不自动提交，AI 验收通过后仍需人工确认方可进入最终完成态。
4. **独立项目移入课程闭环**：独立项目组长可调用 `POST /api/v1/projects/{project_id}/attach-course` 将进行中的独立项目关联至已加入的进行中课程；后端校验项目组长与课程学生身份，自动复用该生在课内的未立项小组或按项目名新建小组，自动将已在课内的项目队友同步入组（不移除课外项目成员），完整保留原有任务、计划、证据与集成绑定，并写入 `project.attached_to_course` 审计日志。

### API 与 OpenAPI 契约同步流程

`services/api` 是接口契约的唯一权威来源，CI 通过 `tests/test_openapi_snapshot.py` 强制校验快照一致：

```bash
# 1. 修改 FastAPI 路由或 Pydantic Schema 后导出 OpenAPI 快照
cd services/api && PYTHONPATH=. python scripts/export_openapi.py

# 2. 在仓库根目录重新生成前端 TypeScript 接口类型
npm run api:generate
```

---

## 3. 本地开发与部署指引

### 环境要求

- Node.js `>=20 <25`
- Python `3.12`（建议在 `services/api/.venv` 下安装后端依赖）
- Docker（提供本地 PostgreSQL 与 Redis 容器）

### 本地环境变量与启动

```bash
# 1. 安装前端依赖
npm ci

# 2. 复制环境变量模板并按需填写本地凭据（.env 已纳入 .gitignore）
cp .env.example .env

# 3. 启动本地 PostgreSQL 与 Redis（或直接使用 npm run dev 自动拉起）
docker compose up -d postgres redis

# 4. 一条命令启动后端与前端（前置钩子自动调用 scripts/dev-backend.sh 并执行 alembic upgrade head）
npm run dev          # Web: http://localhost:3000 | API: http://localhost:8000
```

如需手动分步启动后端：

```bash
cd services/api
alembic upgrade head
uvicorn app.main:app --reload --port 8000
```

> **关键运行注意**：
> - **禁止执行 `source .env`**：bash / zsh 会吞掉环境变量中的反斜杠（例如学号校验正则 `^\S{4,20}$` 会被破坏为 `^S{4,20}$`），导致校验误拒。请始终通过 `scripts/dev-backend.sh` 或直接运行 `uvicorn app.main:app`（Pydantic 自动读取仓库根目录 `.env`）。
> - 默认开启真实接口模式（`NEXT_PUBLIC_ENABLE_MOCKS=false`）；Staging 与 Production 强制关闭 Mock。
> - 本地 `capture` 邮件模式的验证码写入数据库 `email_outbox` 表。

#### 服务端初始化管理员账号

```bash
cd services/api && python -m scripts.bootstrap_admin \
  --name "系统管理员" --username admin \
  --school-email admin@must.edu.mo --password "<强密码>"
```

#### 第三方集成环境变量

| 集成能力 | 前端入口 | 后端环境变量 |
| --- | --- | --- |
| Google OIDC 登录 / 账号关联 | 登录页 / 账户中心 | `GOOGLE_CLIENT_ID`、`GOOGLE_CLIENT_SECRET`、`GOOGLE_REDIRECT_URI`（同源 `APP_ORIGIN + /api/v1/auth/google/callback`） |
| GitHub 仓库绑定与同步 | 项目设置 → GitHub 集成 | `GITHUB_APP_ID`、`GITHUB_APP_PRIVATE_KEY`、`GITHUB_APP_SLUG` |
| 个人 GitHub 身份归属 | 账户中心 → 安全与绑定 | `GITHUB_OAUTH_CLIENT_ID`、`GITHUB_OAUTH_CLIENT_SECRET` |
| 飞书群协作洞察 | 项目设置 → 飞书集成 | `FEISHU_APP_ID`、`FEISHU_APP_SECRET` |
| AI 需求分析 / 验收 / 报告 | 项目内 AI 功能 | `OPENROUTER_API_KEY`（或 `AI_API_KEY`）、`AI_MODEL` |

### 完整工程检查与测试命令

#### 前端检查与构建

```bash
npm run lint                       # ESLint 静态检查
npm run typecheck                  # TypeScript 类型检查 (tsc --noEmit)
npm run build                      # Next.js 生产构建
npm run check:routes               # 56 个设计页 + /projects + /admin 路由校验（CHECK_HTTP=1 核对匿名重定向）
npm run check:i18n                 # zh-Hans / zh-Hant / en 三语键与插值参数一致性
npm run test:api-config            # API 功能开关解析冒烟测试
npm run check:workspace-isolation  # 真实模式与演示缓存隔离校验
npm run check:student-ui           # 学生端 UI 基础契约校验
npm run check:admin-ui             # 管理端 UI 壳层与样式作用域校验
npm run check:admin-pages          # 管理端核心页面契约校验
npm run check:ux                   # 导航上下文与统计口径回归断言
npm run check:access               # 角色权限矩阵断言
```

#### 后端与端到端测试

```bash
# 后端格式与静态检查
ruff format --check services/api
ruff check services/api

# 后端集成测试（完整测试套件需本地 PostgreSQL，并先执行 alembic upgrade head）
cd services/api && PYTHONPATH=. pytest -q

# Playwright 端到端测试
npm run test:e2e                   # 默认隔离 Mock 套件（已自动排除 teacher-workbench-*）
npm run test:e2e:teacher           # 教师 5-Hub 工作台专属套件 (e2e/teacher-workbench-t1..t5.spec.ts)
```

### Railway 部署说明（Staging / Production）

- **Staging (`develop` 分支)**：合并至 `develop` 后触发 GitHub Actions CI（前端 lint/typecheck/build/e2e + 后端 ruff/pytest/OpenAPI 一致性），可通过 `node scripts/deploy-staging.mjs` 或 Railway 自动部署。
- **Production (`main` 分支)**：Staging 验收通过后合并至 `main`，使用 `node scripts/deploy-production.mjs` 发布 Web 与 API，可选通过 `node scripts/deploy-d-workers.mjs` 部署异步报告/风险 Worker。
- **容器启动与健康检查**：API 镜像根目录固定为 `services/api`，内置中文字体与 Cairo 支持 PDF/SVG 报告导出；容器入口 `scripts/entrypoint.sh` 按 `RUN_MIGRATIONS_ON_STARTUP` 控制启动迁移，`/readyz` 严格校验数据库 Alembic 迁移头（当前 `0047`）与依赖就绪状态。

更多详细文档请参阅 [前端实现状态](FRONTEND_STATUS.md)、[前端页面地图](docs/architecture/FRONTEND_IMPLEMENTATION_PLAN.md)、[技术方案](docs/architecture/TECHNICAL_PLAN.md)、[开发指南](docs/architecture/DEVELOPMENT.md) 与 [部署文档](docs/architecture/DEPLOYMENT.md)。
