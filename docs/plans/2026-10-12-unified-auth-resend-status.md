# 统一认证后端 + Resend 兼容改造：实施状态

对应计划：[PLAN.md](./PLAN.md)（统一认证后端 + Resend）。
分支：`compat/unified-auth-resend`（自团队 `develop` 481f35b 创建）。
本文记录实际变更、检查结果、限制与下一阶段接口。**本文为实施记录，不是全部验收完成的声明。**

## 一、已完成范围（PLAN 第 2–4 步的代码部分）

### 1. 统一认证迁入团队 API（PLAN 二、1）

- 独立 `server/app` 认证栈迁入 `services/api/app/auth/`：
  - `security.py`（密码散列/令牌/规范化）、`guard.py`（会话+CSRF+注册资格校验）、
    `services/`（sessions、accounts、registration、pre_registration、email_challenges、
    password_recovery、rate_limit、audit、authz、bootstrap、acceptance、google_oidc、mailer）。
  - `routers/`：`auth.py`（注册/登录/密码恢复/会话）、`me.py`（资料/学校邮箱/教师申请/改密）、
    `admin.py`（教师审核/停用）、`c_admin.py`（身份目录/停用/审核）、`capabilities.py`。
  - 路径与主要请求字段保持不变（`/api/v1/auth/*`、`/api/v1/me/*`、`/api/v1/admin/*`、`/api/v1/c-admin/*`）。
- 响应适配团队统一封装（PLAN 二、3）：成功 `{data, meta:{request_id}}`、
  错误 `{error:{code,message,details}, meta}`；details 携带 `params/fieldErrors/retryAfterSeconds`
  供前端按 code 翻译。封装在 `app/auth/envelope.py`（路由级）与 `app/auth/errors.py`（错误级）统一实现。

### 2. 统一身份与数据（PLAN 二、2）

- 团队 `users`（UUID）为唯一身份；认证附属表全部以 `user_id` 外键指向 `users(id)`：
  `auth_identities`、`school_email_bindings`、`academic_identity_checks`、`auth_sessions`、
  `email_challenges`、`teacher_applications`、`auth_audit_events`、`auth_rate_limits`、
  `oauth_transactions`、`password_credentials`、`pre_registration_requests`、`email_outbox`、
  `auth_legacy_id_map`（旧 ID → UUID 持久化映射）。
- 迁移进入团队迁移链：`services/api/migrations/versions/0013_auth_unification.py`
  （含 downgrade；`alembic check` 无漂移）。会话表用 `auth_sessions`，避免与团队 `sessions`（OAuth 连接）冲突。
- `users` 增加认证字段：`username_normalized/requested_identity/preferred_locale/auth_version/
  last_login_at/disabled_reason/disabled_at`；申报字段（name/username/email/college）改为可空，
  完整性由注册规则（`derive_facts`）判断，不落可写的注册完成布尔。
- 兼容视图（`app/db/models/core.py`，迁移期）：`roles → global_role`、`account_status → status`、
  `version → lock_version` 三个只映射不双写的属性；业务权限继续读 `global_role`/`status`。
- 登录邮箱与学校邮箱分别保存验证（`password_credentials.login_email*` / `school_email_bindings.*`）；
  `users.email` 仅为业务展示/检索镜像（各建档点已回填），密码散列、审核历史、账号状态均保留。
- 导入工具：`services/api/scripts/import_legacy_auth.py` + `app/auth/legacy_import.py`
  （默认 dry-run 预演、幂等重跑、账号冲突暂停不合并、`APP_MODE=real` 拒绝执行；旧会话不导入，切换时作废）。

### 3. 邮件部分重设计（PLAN 三）

- `MAIL_MODE` 增加 `resend`（保留 `smtp`、`capture`）；`RESEND_API_KEY`、`MAIL_FROM`、
  `MAIL_PUBLIC_ENABLED`（默认 false）、`APP_ORIGIN` 分环境配置（`app/auth/config.py`）。
- Resend 适配器（`app/auth/services/mailer.py`）：复用三语模板；幂等键按同一逻辑邮件内容推导
  （同码重试同键、用户重发新码新键）；网络/5xx 有限重试，429 与密钥/域名/额度类错误停止重试并记录原因；
  日志只记用途/状态/服务商消息 ID，不记验证码、令牌、API Key。
- 能力三分（config 派生）：`mail_configured`（配置完整）、`mail_publicly_available`（允许公开发信，
  capture 之外需 `MAIL_PUBLIC_ENABLED=true`）、每次发送结果单独记录；
  `/api/v1/auth/capabilities` 的 `emailSignup/passwordReset/schoolEmailVerification.available`
  按公开发信能力上报（无域名阶段入口显示暂不可用）。
- 受控测试发信命令：`services/api/scripts/send_test_email.py`（仅服务端手动执行，无公开测试发信接口）。

### 4. 前端与本人首页接口（PLAN 二、3）

- `app/api/v1/[...path]/route.ts`：运行时同源代理，转发 Cookie/Origin/CSRF，保留全部 `Set-Cookie`，
  `Cache-Control: private, no-store`，流式透传（支持 SSE）；`next.config.mjs` 的 rewrites 保留为兜底。
- `lib/api/auth-client.ts`：适配统一封装（`unwrapData`/`toApiError`），错误仍按稳定 code 翻译；
  `lib/api/c-identity-client.ts`、`lib/auth/server.ts` 同步解包。
- `packages/domain/openapi.json` 由 `app.main.app.openapi()` 重新导出（含 33 个认证/账户/身份管理路径），
  `npm run api:generate` 已再生成类型；`AdminUserDTO` 申报字段改为可空（注册中途账号可出现在目录中）。
- 业务接口取用户：`app/api/auth.py` 的 `get_current_user` 改为真实 Cookie 会话
  （注册事实齐全 + 登录邮箱已验证才放行 full 业务范围）；`X-Demo-User-Id` 仅限
  `APP_ENV∈{development,test}` 且 `ENABLE_DEMO_AUTH=true` 的隔离联调。

## 二、检查结果（本地实际运行）

| 检查 | 结果 |
| --- | --- |
| `ruff format --check` / `ruff check`（services/api） | 通过 |
| `alembic upgrade head` → `alembic check` | 通过（0013 无 schema 漂移；downgrade 已验证） |
| `pytest -q`（services/api，PostgreSQL） | 829 passed |
| 新增测试 | `test_auth_flows.py`（6）、`test_auth_mailer_resend.py`（8）、`test_auth_legacy_import.py`（2）、`test_database.py` 更新 |
| `npm run typecheck` / `npm run lint` / `npm run build` | 通过 |

关键流程实测通过：邮箱注册（capture）→ 会话 Cookie → `/api/v1/me` → 资料/学校邮箱验证 →
accountState=active → 业务接口放行；未完成验证的账号业务接口 403（REGISTRATION_REQUIRED）；
登录失败统一 `INVALID_CREDENTIALS` 且不泄露账户存在；CSRF 缺失拒绝写操作。

## 三、限制与未完成项（明确区分）

1. **发信域名未验证（PLAN 三、3）**：`MAIL_PUBLIC_ENABLED` 保持 `false`；面向用户的邮箱注册、
   学校验证码、密码找回入口对外显示暂不可用；真实投递仅允许 `send_test_email.py` 受控验证。
   完整注册/学校验证/密码找回的线上验收需域名条件满足后进行（PLAN 第 6 步）。
2. **部署与发布未执行（PLAN 第 1、5、7 步）**：Railway 服务对应关系核对、数据库备份、
   Docker/CI 组合验证、生产发布需要部署权限与备份流程，本轮只完成代码与本地验证。
   发布前必须：备份 → `alembic upgrade head` → API 就绪 → Web 发布 → 实际流程验证；
   切换认证实现时撤销旧会话（旧 `sessions` 表数据未迁移，视作历史连接记录）。
3. **Google 登录**：能力开关默认开，且 `google.available`（入口可见性）随开关上报（2026-10-12 用户决策，
   取代计划中的“本轮关闭”）——登录页先显示 Google 按钮；实际登录为后续事项：点击入口在未配置
   `GOOGLE_CLIENT_ID/SECRET/REDIRECT_URI` 时返回明确的 `AUTH_UNAVAILABLE`（503），不发起外部请求；
   `APP_MODE=real` 下开关开启仍要求凭据齐全（发布检查）。`auth_identities` 历史数据保留。
4. **兼容视图待收敛**：`roles/account_status/version` 三个属性为迁移期映射，
   后续可让业务代码直接读 `global_role/status/lock_version` 后移除。
5. **前端真实浏览器 e2e 未运行**：Playwright 用例与生成类型已同步，e2e 需在有前后端联跑的环境执行。
6. **本地旧数据导入未实跑**：工具与测试就绪，实际导入需先备份并在测试库预演（dry-run）后再 `--apply`。

## 四、下一阶段接口（PLAN 第 5–7 步）

- 受控测试环境验证：真实 Web + API + PostgreSQL 组合跑登录/业务访问；
  `MAIL_MODE=resend` 时用 `scripts/send_test_email.py` 向 Resend 关联邮箱做允许范围内的投递测试。
- 域名条件满足后：验证发信域名 → 更新 `MAIL_FROM` → 向受控普通/学校邮箱验收完整流程 →
  开启 `MAIL_PUBLIC_ENABLED=true` → 再对外宣布注册/密码恢复可用。
- 发布：PR 合入 `develop`，按“数据库迁移 → API 就绪 → Web 发布 → 实际流程验证”执行；回退用
  能读取升级后数据的成套 Web/API 版本，不自动清库或降级迁移。
