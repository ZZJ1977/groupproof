# 管理后台真实后端阶段报告（2026-11-22）

## 范围

在 `admin-backend` 分支复用 `services/api` 的统一身份和 PostgreSQL 领域服务，完成 Admin 六页所需的真实治理接线：用户目录与账号停用/恢复/创建、教师申请审核、课程生命周期、认证/共享审计读取、AI 用量读取、临时只读访问申请与实际内容权限检查。保留现有 `/admin/*` URL、real feature flags 和 `server/` 历史参考边界。

## 实际变更

- `governance_read_ports.py` 新增 `DatabaseUsagePort`，从 A7 `a_ai_usage_events` 冻结一个请求内的真实快照；分页、模型筛选、重复行和窗口上限经过校验。
- 用量 schema/service 接受真实记录中的空用户、模型、Token 或费用，并返回 `unpriced_requests`、`incomplete_token_records`；费用按币种分别累计，不把未知值改成零。
- Admin 账号创建可将教师账号放入待审核状态；恢复、审核和通知失败回滚路径有测试。已有课程版本/CAS、CSRF、幂等键、理由和审计规则继续生效。
- 临时授权接入任务、证据和项目读取：授权只读、按资源精确匹配，过期/撤销后再次读取被拒绝；写操作不会因临时授权放行。
- Admin 前端增加真实状态、共享审计角色/结果筛选、账号创建/恢复、访问申请以及 AI 缺失计费提示；生成并同步 OpenAPI 类型。
- SQLite 文件测试夹具补齐 `a_inboxes` / `a_notifications`，使已有通知副作用测试与 A 共享模型一致。

## 验证结果

使用临时虚拟环境 `/tmp/groupproof-admin-venv`（按 `services/api/requirements.txt` 安装；不修改仓库依赖）执行：

- `cd services/api && PYTHONPATH=. python -m pytest tests/test_c_governance_reads.py tests/test_c_governance_http.py -q`：34 passed。
- `cd services/api && PYTHONPATH=. python -m pytest tests/test_a_admin_accounts.py tests/test_c_admin_users.py tests/test_c_governance.py tests/test_c_shared_audit.py tests/test_c_granted_content.py tests/test_c_auth_verification_integration.py -q`：110 passed。
- `cd services/api && PYTHONPATH=. python -m pytest tests/test_openapi_snapshot.py -q`：1 passed。
- `cd services/api && ruff check app tests && ruff format --check app tests`：通过。
- 根目录 `npm run api:generate`、`npm run lint`、`npm run typecheck`：通过。
- 全量 API pytest：`993 passed, 253 skipped, 5 warnings`（65.85s）。最初的 3 个文件发布测试因 SQLite 夹具缺少 `a_inboxes` / `a_notifications` 失败，补齐夹具后全量通过；跳过项来自测试 README 记录的外部 PostgreSQL/Redis 条件。

## Railway 状态与限制

- 已确认 API 使用 `services/api/railway.toml` 的 Dockerfile、`alembic upgrade head` 和 `/readyz`；Web/API/Postgres/Redis/可选 worker 的边界沿用现有部署文档。
- 已在已登录的 Railway workspace 中创建新项目 `groupproof-admin`（project ID `c96385e7-2109-4250-be01-5100b1d55521`，production environment ID `95b0f49f-afca-4636-81fc-222636ba16f5`），并建立 `Postgres`、`Redis`、`api`、`web`、`worker` 五个服务。Postgres/Redis 已由 Railway 自动部署；应用服务暂未连接代码源、变量或部署，避免未配置 secrets 时触发失败发布。
- `admin-backend` 已推送到 `ZZJ1977/groupproof` 远端分支；下一步可在确认变量和根目录/启动命令后，把 `api`/`web`/`worker` 分别绑定此分支并逐项部署。当前不能把本地测试或数据库服务在线当作应用线上验收。
- 旧业务审计端点 `/api/v1/admin/audit-logs` 仍保留兼容契约并在 provider 未接通时返回 503；管理日志默认入口使用已接通的 `/api/v1/admin/shared-audit-events`，页面会明确显示来源与不可用状态。
