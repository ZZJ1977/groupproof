# API service

这是 FastAPI 模块化单体的入口。A2 提供了一个可运行的 PostgreSQL 读取、权限检查和并发更新示例；业务模块由各成员在自己的目录中实现。

## 后台任务和进度

`app.modules.tasks.router` 提供 A2-06 的任务协议，已经由 `app.main` 注册：

```text
POST /api/tasks                         # 开发/测试环境提交示例耗时任务
GET  /api/tasks/{task_id}               # 读取最新状态
GET  /api/tasks/{task_id}/events        # text/event-stream 实时进度
```

提交响应使用统一的 `data`/`meta` 信封，并返回 `task_id` 和 `stream_url`。SSE 每条
事件包含任务状态、百分比、提示、结果或错误；客户端重连时发送 `Last-Event-ID`，
服务会从 Redis Stream 继续回放。API 和 worker 必须使用同一个 `REDIS_URL`。

目录边界：

- `app/modules/a`：A 负责的认证、平台和外部接入
- `app/modules/b`：B 负责的课程、项目初始化和任务计划
- `app/modules/c`：C 负责的活动、证据和管理后台
- `app/modules/d`：D 负责的验收、贡献、报告和教师端
- `tests`：后端测试
- `migrations`：唯一的 Alembic 迁移目录，所有结构变化都必须提交迁移文件

## 数据库迁移

API 使用 PostgreSQL/pgvector、SQLAlchemy 2.x 和 Alembic。连接串从 `DATABASE_URL` 读取，默认时区为 `Asia/Shanghai`，可用 `DATABASE_TIMEZONE` 覆盖。

在 `services/api` 目录执行：

```bash
export APP_ENV=development
alembic upgrade head
APP_ENV=development python -m scripts.seed_core
alembic current
alembic downgrade -1  # 仅用于本地验证回滚
```

`scripts.seed_core` 会创建一套覆盖核心身份、课程、小组、项目、需求冲突、里程碑、任务依赖、验收标准、基线、计划和进度事件的演示图，并且重复执行安全。脚本读取 `APP_ENV`，只接受 `development` 或 `test`；在 `staging`、`production`、未设置或其他环境下会直接拒绝执行。生产环境不要把演示数据当作业务初始化数据。

## A2 API 合同示例

`GET /api/examples/projects/{project_id}` 从 `projects` 表读取项目，并要求请求用户是该项目的活跃成员。
`PATCH /api/examples/projects/{project_id}` 只允许项目组长修改名称。请求体必须包含当前的
`expected_version`；服务端使用 `WHERE id = :id AND lock_version = :expected_version` 原子更新，
成功后版本号加一，版本过期返回 `409 VERSION_CONFLICT`。

除健康检查、模块 ready 探针和 SSE 事件流外，业务接口使用统一 JSON 合同：

```json
{
  "data": {},
  "meta": {"request_id": "..."}
}
```

错误响应使用 `error.code`、`error.message` 和可选 `error.details`，并统一覆盖认证、权限、
资源不存在、参数校验和并发冲突（`401`、`403`、`404`、`422`、`409`）。每个响应都带有
`X-Request-Id`，便于日志追踪。

真实 session 认证在 A3 接入前，示例接口只接受明确开启的本地临时身份：设置
`APP_ENV=development ENABLE_DEMO_AUTH=true`，并在请求中传入已 seed 用户的
`X-Demo-User-Id`。该开关在生产环境不会启用；不要把临时身份机制用于真实用户。
