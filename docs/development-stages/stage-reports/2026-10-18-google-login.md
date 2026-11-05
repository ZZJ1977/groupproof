# 迭代报告：Google 登录打通（2026-10-18）

日期：2026-10-18 · 需求来源：负责人要求打通 Google 登录 · 依据文档：[执行指南](../../plans/2026-10-18-google-login-agent-guide.md)与[背景方案](../../plans/2026-10-18-google-login-plan.md)（均只读）· 状态：**本地联调全通过；PR 待合并；Staging 待负责人同意；生产仅记录待办**

基线：GitHub `ZZJ1977/groupproof` `develop`（`22c0d1a`）→ 分支 `feat/google-login`。认证后端在 `services/api/app/auth/`；`server/` 仅参考未改动。Google 凭据只存在本地 `.env`（gitignore 已确认），未进入任何提交/文档/输出。

## 任务范围

按指南第 2–5 节执行：本地配置与冒烟、四个代码缺口（回调地址启动检查、回调失败统一回登录页、邮箱冲突不自动建号、账户安全关联/解除 Google）、测试补齐（隔离 OIDC stub + 九组用例）、本地真实联调四项；提交按阶段拆分并向 `develop` 开 PR。生产（`main`/`groupproof-production`）一律不动，只记录待办。

## 实现内容

### 1. 本地配置与回调地址默认值（`1e5813c`）

- `.env.example` 的 `GOOGLE_REDIRECT_URI` 默认值由 `:8000` 改为 Web 同源 `http://localhost:3000/api/v1/auth/google/callback`（ID/secret 保持空值）；本地 `.env` 按指南第 2 节配置。

### 2. 回调地址启动检查（3.1，`25da628`，`services/api/app/auth/config.py`）

- `google_configured` 时要求 `GOOGLE_REDIRECT_URI == APP_ORIGIN + /api/v1/auth/google/callback`：`APP_MODE=real` 不满足即 `RuntimeError`（中文提示应填值），dev/mock 仅 `logging.warning` 不阻断。测试 3 例并入 `tests/test_auth_mailer_resend.py`。

### 3. 回调失败统一跳回登录页（3.2，`0acf31d`，`app/auth/routers/auth.py`）

- `google_callback` 增加 `error` 参数：`access_denied` → `/login?error=cancelled`；state 校验失败/事务消费失败/验签 401 类 → `/login?error=failed`；Google/数据库 503 类 → `/login?error=unavailable`。不再向浏览器返回 JSON。
- 新增 `_google_failure()` 统一出口：审计 `auth.google.failed`（reason 放 `changed_fields=["reason:…"]`，不含 token）、删除 `oauth_cookie_name`、302。`google_start` 未配置时同样 302 到 `unavailable`（原 503 JSON）。
- 前端 `LoginPage.tsx` 的 `unavailable` 三语文案确认已存在，无需改动。

### 4. 邮箱冲突不自动建号（3.3，`c5cfcec`）

- 建号分支先检测：`email_verified` 的 Google 邮箱等于某用户**已验证**登录邮箱（`password_credentials.login_email_verified_at`）或**已验证**学校邮箱（`school_email_bindings.verified_at`）→ 不建号不发会话，审计 `auth.google.account_exists`，302 `/login?error=account_exists`；未验证邮箱不算冲突，照常建号。
- `LoginPage.tsx` 增 `account_exists` 分支；三语文案："该邮箱已有 GroupProof 账号，请先用密码登录，再到账户安全中关联 Google。"

### 5. 账户安全关联/解除 Google（3.4，`876ee4b`）

- **迁移 `0014_oauth_link_purpose.py`**：`oauth_transactions` 增 `purpose`（`login|link`，非空默认 `login`）与 `user_id`（可空，FK `users.id` ON DELETE CASCADE）。PostgreSQL 实测 upgrade ✅ / `alembic check` 无漂移 ✅ / downgrade ✅ / 再 upgrade ✅。
- **接口**（`app/auth/routers/me.py`）：`POST /api/v1/me/identities/google/link`（近期认证校验，否则 `REAUTH_REQUIRED`；已绑定 `IDENTITY_ALREADY_LINKED`；返回 `authorizeUrl` 整页跳转，state Cookie 与 `google_start` 一致）；`DELETE /api/v1/me/identities/google`（无密码凭据或登录邮箱未验证 → `LAST_SIGN_IN_METHOD` 防锁死；审计 `auth.google.unlinked`）；`GET /api/v1/me` 增 `googleEmail`（`_mask_email` 脱敏）。
- **回调 link 分支**（`_complete_google_link`）：会话用户必须等于 `transaction.user_id`（否则 `/account/security?error=failed`）；sub 已绑他人 → `?error=identity_linked_elsewhere`；成功只建 `AuthIdentity` 绑定、审计 `auth.google.linked`、不建用户不换会话、302 `?linked=google`。
- **前端**：`lib/api/auth-client.ts` 增 `linkGoogle()/unlinkGoogle()`；`features/account/AccountView.tsx` 账户安全区新增 Google 卡片（未绑定→关联按钮；已绑定→脱敏邮箱+解除关联，无密码禁用并说明）；读取 `?linked=google`/`?error=…`；三语文案；`packages/domain/openapi.json` 重新导出 + `npm run api:generate`。
- `google_oidc.create_transaction` 支持 `purpose`/`user_id`；新增错误码 `IDENTITY_ALREADY_LINKED`、`LAST_SIGN_IN_METHOD`。

### 6. 测试（3.5，`7a0c09f`）

- `server/tests/oidc_stub.py` 迁至 `services/api/tests/oidc_stub.py`（隔离 OIDC 提供方：discovery/JWKS/token + 可控签发）；fixture 以 `GOOGLE_DISCOVERY_URL` 指向 stub，仅测试使用。
- `tests/test_auth_google.py` 18 用例覆盖指南九组：首次登录建号+会话+跳资料页；再次登录命中同一用户；state 缺失/不匹配/过期/重放 → `failed`；nonce/aud/issuer 错 → `failed`；`access_denied` → `cancelled`；已验证邮箱冲突不建号（审计断言）+ 未验证照常建号；关联成功/近期认证过期 `REAUTH_REQUIRED`/sub 已被他人绑定 `identity_linked_elsewhere`；纯 Google 解除被拒 `LAST_SIGN_IN_METHOD`+有密码解除成功（审计断言）；新 Google 用户业务接口 403 `REGISTRATION_REQUIRED`。

### 7. 联调期间定位并修复的问题（各带回归测试）

| 问题 | 根因 | 修复 |
|---|---|---|
| 学号 `1240025428` 被拒 `invalid_student_id` | 启动 API 时用 `set -a; source .env`：bash 吃掉反斜杠，`^\S{4,20}$` 变 `^S{4,20}$`，且环境变量优先于 .env 文件 | 改用 `scripts/dev-backend.sh` / 直接 uvicorn（pydantic 自读 `.env`）启动；回归测试默认规则接受 10 位纯数字（`d494b60`） |
| 前端露出原始 key `account.profile.invalid_student_id` | `fieldError` 查 `account.profile.<code>`，文案实际在 `account.profile.errors.<code>` | 改查 `errors.<code>`；核查全部字段错误码三语齐全，补邻近命名空间可达缺失码（`73aafc8`） |
| Google 登录"服务暂不可用" | `config.py` 的 `_REPO_ROOT = parents[3]` 少一层（指向 `services/`），pydantic 读的是不存在的 `services/.env`，凭据全部读空（`develop` 既有问题，此前被 `source .env` 掩盖） | `parents[4]` + 回归测试断言 `_REPO_ROOT` 含 `services/api/app`（`fb97791`） |
| 未验证邮箱建号 503 | `users.email` 全局唯一约束，Google 建号的邮箱镜像被占用 | 镜像改尽力而为（被占用不写镜像；身份事实在 `auth_identities`）（`8b5051a`） |
| 测试期望迁移头 0013 | 0014 新增后两处硬编码期望值 | 更新 `test_readiness.py`/`test_database.py` 至 0014（随 `876ee4b`） |

## 验证结果（2026-10-18 实际运行）

| 命令 | 结果 |
|---|---|
| `ruff format --check app migrations scripts tests` | 通过（177 files formatted） |
| `ruff check app migrations scripts tests` | 通过 |
| `pytest -q`（含 `DATABASE_URL`/`C_TEST_DATABASE_URL`/`C_EXECUTION_TEST_DATABASE_URL`，PostgreSQL 本地容器） | **892 passed / 0 skipped**（含 18 个 Google OIDC 用例、2 个回归测试） |
| `npm run lint` / `npm run typecheck` / `npm run build` | 全部通过 |
| 迁移 0014：`alembic upgrade head` / `alembic check` / `alembic downgrade 0013` / 再 upgrade | 全部通过，无漂移 |

**第 4 节本地真实联调（负责人浏览器实际操作 + 服务端数据库/日志核验；按负责人决定未留截图）**：

| # | 场景 | 结果 |
|---|---|---|
| 1 | 新 Google 账号 → 学生入台：登录 → 资料（学号 1240025428）→ 学校邮箱验证码 → 工作台 | ✅ 全链路通过（库核验：`status=active`、school_verified=true） |
| 2 | 教师流程：教师资料 + `@must.edu.mo` 测试邮箱 → 验证码 → 提交教师申请 → 服务端 `bootstrap_admin` + 审核接口 approve | ✅ 通过（库核验：`global_role=teacher`、申请 `approved`） |
| 3 | 密码账号（scratchuser01）→ 账户安全关联 Google → 退出 → Google 登录进入同一账号 | ✅ 通过（同一账号确认） |
| 4 | Google 页面取消 → 登录页"已取消登录"；复制回调地址重放 → "登录失败" | ✅ 与预期一致（非 JSON，提示文案正确） |

## 工程约定（本次新增/重申）

1. **本地启动 API**：用 `scripts/dev-backend.sh` 或直接 `uvicorn app.main:app`（pydantic 自读仓库根 `.env`）；**禁止 `source .env`**——bash 会破坏含反斜杠的值（如 `STUDENT_ID_PATTERN` 正则）。
2. **后端测试**：需本地 PostgreSQL（`docker compose up -d postgres redis`）并设置 `DATABASE_URL`、`C_TEST_DATABASE_URL`、`C_EXECUTION_TEST_DATABASE_URL`，否则部分用例跳过。
3. **capture 模式验证码**写 `email_outbox` 表（不是 `.mail-capture/` 目录），联调时从库里读码。
4. 回调地址必须 Web 同源（`<APP_ORIGIN>/api/v1/auth/google/callback`），3.1 的启动检查会拦截 API 域名/`:8000` 写法。

## 遗留限制 / 未验证项

1. **截图**：指南第 8 节要求"四项通过并有截图"；负责人明确本次不提供截图，第 4 节证据为人工确认 + 数据库/日志核验。如需补拍可随时重跑场景（测试用户按约定"报 ID 后删"即可用同一 Google 账号复测）。
2. **Staging 未执行**（指南第 6 节）：需负责人同意后操作 Railway。已知限制 `MAIL_PUBLIC_ENABLED=false`，新 Google 用户会停在学校邮箱验证一步，属发信域名问题非 Google 登录问题。
3. **真实 UI 错误文案**未逐屏截图核对（映射已由测试覆盖三语）。
4. 本机 httpx 会经 macOS 系统代理转发回环流量（stub 502），测试配置内 `NO_PROXY=127.0.0.1` 绕过；生产代码调真实 Google 走代理属正常行为，未改。
5. 本机无 `gh` CLI，PR 以分支推送 + compare 链接交付（描述见下）。

## 下一阶段接口 / 移交

1. **PR → `develop`**：标题 `feat(auth): Google sign-in, linking, and account conflict handling`；目标 develop；CI 绿后负责人审查合并。
2. **Staging（负责人同意后）**：确认 Staging 回调地址已登记 → Railway `groupproof-staging` 的 **API 服务**设 `GOOGLE_CLIENT_ID/SECRET/REDIRECT_URI`（与本地同一对）、`AUTH_GOOGLE_ENABLED=true`，核对 `APP_ORIGIN` → 重部署 → `/readyz` + `capabilities.google.available` + 联调项 1/3/4。
3. **生产（只记录）**：Web 自定义域名 + 同意屏幕 Authorized domains；同意屏幕发布 In production；生产客户端与回调地址登记；生产 API 设 `GOOGLE_*`（`APP_MODE=real` 下缺失或回调不匹配会启动失败，即 3.1 检查）；`bootstrap_admin --google-sub <sub>` 为负责人建管理员（sub 取首次登录审计记录）。
