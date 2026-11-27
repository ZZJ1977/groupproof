# API service

`services/api` 是 GroupProof 统一的 FastAPI 认证与业务后端，基于 PostgreSQL（pgvector）、SQLAlchemy 2.x、Alembic 与 Redis/Celery 构建，已在 Railway Staging 与 Production 上线运行。

## 目录与模块边界

- `app/auth/`：统一认证与身份服务（Cookie 会话、CSRF 守卫、学校邮箱验证码注册/找回、Google OIDC 登录与关联、教师审核、个人 GitHub 身份授权及 `c_admin` 治理路由）
- `app/modules/a/`：共享权限引擎、站内通知/待办、不可变审计日志、文件存储（Supabase Storage + PostgreSQL Large Object 回退）、GitHub App / 飞书机器人同步、临时只读授权与 OpenRouter AI 中间层（详见 [A_SHARED_SERVICES.md](../../docs/modules/a/A_SHARED_SERVICES.md)）
- `app/modules/b/`：课程入班与规则、小组与组队广场、独立/课程项目初始化与正文提取、需求基线、任务规划、里程碑、成员变动及教师端班级工作台（接口约定见 [B_INTERFACES.md](../../docs/modules/b/B_INTERFACES.md)）
- `app/modules/c/`：日常首页与个人动态、收件箱代理、任务执行状态机与进度汇总、实施说明与证据生命周期、项目/课程文件版本、讨论区、GitHub/飞书活动记录及管理治理读取（详见 [docs/modules/c/C_DELIVERY.md](../../docs/modules/c/C_DELIVERY.md)）
- `app/modules/d/`：完整性检查、AI 辅助逐条验收与人工确认、贡献计算（v2）与快照冻结、风险检测、7 章节结项报告生成/审批与 PDF/DOCX 导出、教师工作台评阅与课程归档
- `app/modules/tasks/`：异步耗时任务协议与 SSE 实时进度流
- `migrations/`：唯一 Alembic 迁移链（当前迁移头 `0047_a_activity_summaries`），所有表结构变更均须提交迁移文件
- `scripts/`：运维与工具脚本（`bootstrap_admin.py`、`export_openapi.py`、`daily_risks.py`、`seed_core.py` 等）
- `tests/`：后端单元、HTTP 契约、PostgreSQL 并发/迁移及全生命周期集成测试（详见 [tests/README.md](tests/README.md)）

## 健康检查与后台进程

- `GET /healthz`：进程存活探针。
- `GET /readyz`：数据库迁移就绪探针，仅当数据库 `alembic_version` 达到当前镜像的迁移头时返回 `200 ready`，否则返回 `503`。
- 异步任务与进度流（`app.modules.tasks.router`）：
  ```text
  POST /api/tasks                         # 开发/测试环境提交示例耗时任务
  GET  /api/tasks/{task_id}               # 读取最新状态
  GET  /api/tasks/{task_id}/events        # text/event-stream 实时进度（支持 Last-Event-ID 回放）
  ```
- 部署配置：
  - `railway.toml`：API Web 服务（容器启动默认幂等执行 `alembic upgrade head`）
  - `railway-report-worker.toml`：结项报告导出 Celery Worker（`celery -A app.modules.d.report_tasks:celery_app worker`；开发环境无独立 Worker 时自动进程内回退）
  - `railway-risk-scheduler.toml`：每日风险巡检调度器（`python -m scripts.daily_risks --loop`）

## 本地运行与数据库迁移

本地推荐在仓库根目录直接执行 `npm run dev`（前置脚本 `scripts/dev-backend.sh` 会幂等启动 Compose 的 `postgres`/`redis`/`api` 并执行迁移），或在 `services/api` 目录手动运行 `uvicorn app.main:app`（配置由 Pydantic 自动读取仓库根 `.env`；**请勿直接对 `.env` 执行 `source`**，以免 shell 破坏学号正则等含反斜杠的值）。

数据库迁移默认使用 `DATABASE_URL`，时区默认为 `Asia/Shanghai`（可用 `DATABASE_TIMEZONE` 覆盖）。在 `services/api` 目录执行：

```bash
alembic upgrade head
alembic current
alembic check
```

受控开通初始管理员账号（不开放公开管理员注册）：

```bash
python -m scripts.bootstrap_admin \
  --name "系统管理员" --username admin \
  --school-email admin@must.edu.mo --password "<强密码>"
```

开发/测试环境如需写入本地基础演示图，可显式在隔离环境运行 `APP_ENV=development python -m scripts.seed_core`（在 `staging`、`production` 或未设置 `APP_ENV` 时会直接拒绝，严禁用于正式库）。

## 统一 API 响应与认证契约

除健康探针与 SSE 流外，所有 `/api/v1/*` 业务接口均返回 `Cache-Control: private, no-store`、`X-Request-Id` 与统一 JSON 封装：

```json
{
  "data": {},
  "meta": {"request_id": "..."}
}
```

错误响应统一使用 `error.code`、`error.message` 与可选 `error.details`，覆盖认证（`401`）、权限（`403`）、资源不存在（`404`）、并发乐观锁冲突（`409`）、参数校验（`422`）及外部依赖不可用（`503`）。

正式请求全部采用 `app/auth` 提供的服务端 Cookie 会话与 CSRF 令牌校验（写操作同时校验 `X-CSRF-Token` 与幂等键 `Idempotency-Key`）。历史示例路由中的 `ENABLE_DEMO_AUTH=true` + `X-Demo-User-Id` 仅允许在显式本地开发/测试隔离环境下使用，在 Staging 与 Production 中强制禁用。
