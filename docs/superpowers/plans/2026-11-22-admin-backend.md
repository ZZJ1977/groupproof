# Admin Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 `admin-backend` 分支上把现有 Admin 六个页面接到可验证的真实服务端治理能力，并为独立 Railway 项目准备可审计的部署边界。

**Architecture:** 继续扩展 `services/api` 这一套统一身份与 PostgreSQL 后端，复用已有 `/api/v1/admin`、`/api/v1/c-admin`、C7 治理服务、迁移和审计契约；Next.js 只通过现有 `/admin/*` 页面及 real feature flags 读取真实接口。先接通已有账号、教师审核、课程、审计、AI 用量和临时只读授权能力，再补齐 provider、类型、页面状态和测试，不另建 Admin 服务或用户库。

**Tech Stack:** FastAPI、SQLAlchemy、Alembic、PostgreSQL、Redis、Next.js App Router、React、TypeScript、OpenAPI 生成客户端、pytest、Ruff、npm lint/typecheck/build。

**Spec:** `docs/superpowers/specs/2026-11-22-admin-backend-design.md`

## Global Constraints

- 统一认证和业务 API 的正式入口是 `services/api`；不得在 `server/` 或新目录创建第二套身份、RBAC 或后台 API。
- Admin 写操作必须校验 active 管理员、已验证学校邮箱、CSRF、版本（CAS）和理由；不能自停用或自批准访问。
- 审计记录只追加不修改/删除，输出只允许安全标量；邮箱、凭据、会话、验证码和项目正文不得进入管理日志。
- AI 结果必须标记为需要人工确认；缺少真实用量时返回明确不可用状态，不生成零用量或虚构趋势。
- 临时访问只允许 `read` 与 `project|task|evidence` 范围，每次读取重新检查未过期、未撤销的授权。
- 不改写旧迁移，不改变 Task、Evidence 或正式验收规则；真实服务未接通时 UI 必须显示不可用而不是空数据。
- Railway 凭据只放 Railway Variables/GitHub Secrets；本轮在负责人授权的 workspace 创建了独立项目并部署了服务骨架，应用密钥仍不进入仓库，线上账号能力以实际配置和匿名健康检查结果为准。

## Review Focus

- 非管理员、未验证管理员、失效会话访问 Admin API：必须由服务端拒绝；由 `test_c_governance_http.py` 和认证集成测试覆盖。
- 重放账号/教师/课程/授权写请求或使用旧版本：必须得到幂等结果或明确冲突；由现有 C7 写接口测试及新增回归断言覆盖。
- AI 记录缺少 token/cost/model：页面必须保留可用样本并标明未计价/不完整，而不是把缺失值变成零；由 `test_c_governance_reads.py` 覆盖。
- 审计筛选结果含空 actor、denied 结果或敏感字段：响应必须保持可序列化、脱敏且不假设 UUID；由共享审计 HTTP 测试覆盖。
- 临时授权在过期、撤销、资源或申请人不匹配时实际读取失败；由 `test_c_granted_content.py` 覆盖。

---

### Task 1: 接入真实治理读取端口

**Files:**
- Modify: `services/api/app/modules/c/governance_read_ports.py`
- Modify: `services/api/app/modules/c/governance_read_schemas.py`
- Modify: `services/api/app/modules/c/governance_read_service.py`
- Test: `services/api/tests/test_c_governance_reads.py`
- Test: `services/api/tests/test_c_governance_http.py`

**Interfaces:**
- Consumes: 现有 `AiUsageEvent`/`list_ai_usage`、共享审计查询和治理 read schemas。
- Produces: `DatabaseUsagePort` 及注入 `Session` 的 `get_governance_read_port`；AI 用量查询返回真实记录，缺失 token/cost/model 可被安全表示。

- [ ] **Step 1: 写失败测试**：在治理读取测试中断言配置真实 provider 时返回数据库中的 AI usage 样本、缺失 cost/token 不被改成零，并保留未计价/不完整计数。
- [ ] **Step 2: 运行失败测试**：`cd services/api && PYTHONPATH=. pytest tests/test_c_governance_reads.py tests/test_c_governance_http.py -q`；预期在 provider 仍为不可用或 schema 不接受 `None` 时失败。
- [ ] **Step 3: 实现最小端口接线**：在 `governance_read_ports.py` 用当前 SQLAlchemy `Session` 调用 A 模块的 `list_ai_usage`，冻结 DTO 后交给现有 service；在 schemas/service 中只放宽真实缺失字段并计算明确的 incomplete/unpriced 计数，不改变旧路由契约。
- [ ] **Step 4: 运行绿色测试**：重复上述 pytest，并运行 `ruff check` 与 `ruff format --check`（仅针对修改的 API 文件）。
- [ ] **Step 5: 提交**：`git add services/api/app/modules/c/governance_read_ports.py services/api/app/modules/c/governance_read_schemas.py services/api/app/modules/c/governance_read_service.py services/api/tests/test_c_governance_reads.py services/api/tests/test_c_governance_http.py && git commit -m "feat: connect admin governance read providers"`

### Task 2: 固化账号、教师审核、课程、审计与临时授权回归

**Files:**
- Modify: `services/api/tests/test_a_admin_accounts.py`
- Modify: `services/api/tests/test_c_admin_users.py`
- Modify: `services/api/tests/test_c_governance.py`
- Modify: `services/api/tests/test_c_shared_audit.py`
- Modify: `services/api/tests/test_c_granted_content.py`
- Test: `services/api/tests/test_c_auth_verification_integration.py`

**Interfaces:**
- Consumes: 现有 `/api/v1/admin`、`/api/v1/c-admin`、课程 governance、shared audit、access grants 路由。
- Produces: 可重复执行的成功、失败、冲突、重放、过期和撤销验收证据。

- [ ] **Step 1: 写失败回归断言**：为账号恢复/创建、教师拒绝理由与学校邮箱重检、课程版本冲突、审计脱敏、授权到期/撤销分别补一条最小 HTTP/数据库测试。
- [ ] **Step 2: 运行定向测试**：`cd services/api && PYTHONPATH=. pytest tests/test_a_admin_accounts.py tests/test_c_admin_users.py tests/test_c_governance.py tests/test_c_shared_audit.py tests/test_c_granted_content.py tests/test_c_auth_verification_integration.py -q`；新断言应先失败或暴露当前契约差异。
- [ ] **Step 3: 只修复真实契约缺口**：复用现有事务、CSRF、CAS、幂等和审计服务；不在测试中绕过鉴权，不把不可用 provider 当空列表。
- [ ] **Step 4: 重跑定向测试并记录数据库前置条件**：测试全部通过；若本机缺 PostgreSQL/Redis，明确记录未执行项，不伪称通过。
- [ ] **Step 5: 提交**：`git add services/api/tests/... && git commit -m "test: cover admin governance boundaries"`

### Task 3: 让 Admin 页面只消费真实治理 API

**Files:**
- Modify: `features/c/GovernanceApiPages.tsx`
- Modify: `features/c/IdentityAdminApiPages.tsx`
- Modify: `lib/api/c-governance-client.ts`
- Modify: `lib/api/c-identity-client.ts`
- Modify: `e2e/c-auth-audit-api.spec.ts`
- Modify: `e2e/c-governance-api.spec.ts`

**Interfaces:**
- Consumes: Task 1 的真实治理 read response、现有 `cidentity=real`/`governance=real` 开关。
- Produces: `/admin/users`、`/admin/teachers`、`/admin/courses`、`/admin/audit-logs`、`/admin/auth-audit-logs`、`/admin/ai-usage` 在真实模式下对加载、空结果、503、筛选和敏感字段做明确呈现。

- [ ] **Step 1: 写失败 UI/E2E 断言**：真实 provider 失败显示不可用提示；AI 缺失字段显示“未计价/不完整”而非 0；shared audit 的空 actor/denied 行不导致渲染崩溃。
- [ ] **Step 2: 运行前端定向检查**：`npm run lint`、`npm run typecheck`、相关 Playwright spec；先确认现有页面暴露的类型或状态问题。
- [ ] **Step 3: 实现最小页面/客户端调整**：统一 API 错误解析、分页/筛选参数和 null-safe 映射；保留现有 URL、角色工作区和 Mock 开关，不新增认证入口。
- [ ] **Step 4: 重跑 lint/typecheck/E2E**：真实模式和 Mock 模式均不出现把 503 当空数据的路径。
- [ ] **Step 5: 提交**：`git add features/c/GovernanceApiPages.tsx features/c/IdentityAdminApiPages.tsx lib/api/c-governance-client.ts lib/api/c-identity-client.ts e2e/c-auth-audit-api.spec.ts e2e/c-governance-api.spec.ts && git commit -m "feat: expose real admin governance states"`

### Task 4: 同步 OpenAPI、路由清单和阶段状态

**Files:**
- Modify: generated API client/OpenAPI files produced by `npm run api:generate`
- Modify: `FRONTEND_STATUS.md`
- Modify: `docs/development-stages/README.md` (only the actual admin stage status)
- Test: `services/api/tests/test_openapi_snapshot.py`

**Interfaces:**
- Consumes: Tasks 1–3 的稳定 FastAPI schemas 和现有 route map。
- Produces: 前端类型与 API schema 同步，文档只记录实际已验证能力及未完成 provider/deployment 限制。

- [ ] **Step 1: 导出并检查 OpenAPI**：`cd services/api && PYTHONPATH=. python scripts/export_openapi.py`，再在仓库根执行 `npm run api:generate`。
- [ ] **Step 2: 运行快照与路由检查**：`cd services/api && PYTHONPATH=. pytest tests/test_openapi_snapshot.py -q`; 根目录运行 `npm run check:routes`。
- [ ] **Step 3: 更新状态文档**：标明 real/Mock 边界、测试证据、Railway 尚未创建的原因，不把计划写成已实现。
- [ ] **Step 4: 提交**：`git add <generated-api-files> FRONTEND_STATUS.md docs/development-stages/README.md && git commit -m "docs: record admin backend verification status"`

### Task 5: Railway 新项目部署与匿名验收

**Files:**
- Modify: `docs/DEPLOYMENT.md` (only if the new service boundary or variable checklist needs clarification)
- Create: `docs/development-stages/stage-reports/2026-11-22-admin-backend.md`

**Interfaces:**
- Consumes: Tasks 1–4 的验证结果、`services/api/railway.toml`、现有 deploy scripts 和 Railway CLI 登录状态。
- Produces: `web`/`api`/`postgres`/`redis`/`worker` 的变量与健康检查清单；应用服务绑定 `admin-backend` 分支后逐项部署，未配置的邮件/Google 能力保持关闭。

- [ ] **Step 1: 只读检查 CLI 和凭据状态**：`command -v railway`、`railway whoami`；不得输出 token，不得读取或提交 secrets。
- [ ] **Step 2: 校验部署配置**：确认 API 使用 `alembic upgrade head` 和 `/readyz`，Web 使用 `API_INTERNAL_URL`，真实模式关闭 `NEXT_PUBLIC_ENABLE_MOCKS`。
- [x] **Step 3: 写阶段报告**：列出已验证命令、数据库/Redis 前置条件、Railway 项目/服务 ID、匿名健康检查和仍关闭的外部身份/邮件能力。
- [ ] **Step 4: 提交**：`git add docs/DEPLOYMENT.md docs/development-stages/stage-reports/2026-11-22-admin-backend.md && git commit -m "docs: add admin backend deployment preflight"`

### Final Verification

- [ ] `cd services/api && ruff check app tests && ruff format --check app tests`
- [ ] `cd services/api && PYTHONPATH=. pytest -q`（按测试 README 准备 PostgreSQL/Redis；无法准备时记录具体未执行原因）
- [ ] `npm run lint && npm run typecheck && npm run build && npm run check:routes`
- [ ] `git diff --check`，并确认 `git status` 中只有本分支提交和用户原有未提交文件；不提交 `next-env.d.ts`、`docs/END_TO_END_TEAM_SPLIT.md`、`docs/TEAM_TASK_ASSIGNMENT.md`、`docs/erd-preview/`、`tmp/`。
