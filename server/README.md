# GroupProof 身份与账户服务（FastAPI）

更新日期：2026-10-08。FastAPI 是身份与授权事实的唯一服务端来源：Google OIDC 认证、账号密码注册/登录（bcrypt）、可撤销会话、
注册资格派生、学校邮箱验证码、教师审核、账号停用、审计与业务资源授权（权限矩阵同 `lib/access/policy.ts`）。

## 目录

```text
app/
  config.py            运行配置（APP_MODE=real 缺配置即启动失败，不退回 Mock）
  db.py                SQLAlchemy 引擎/事务边界
  models.py            users/auth_identities/school_email_bindings/academic_identity_checks/
                       sessions/email_challenges/teacher_applications/auth_audit_events/
                       oauth_transactions/auth_rate_limits/email_outbox
  security.py          令牌摘要、验证码 HMAC、returnTo 白名单、邮箱/用户名规范化、CSRF/Origin
  guard.py             require_session / require_active_user / require_admin / check_csrf
  services/
    registration.py    RegistrationFacts 派生（disabled→profile→email→review→active）
    sessions.py        签发/轮换/撤销/期限/refresh
    email_challenges.py 验证码挑战：HMAC、一次性消费、限流、原子绑定
    accounts.py        资料白名单、核验失效规则、换绑、教师申请/审核、停用、偏好
    google_oidc.py     Authlib：Authorization Code + PKCE S256 + state/nonce（事务持久化）
    authz.py           业务资源授权矩阵（阶段 01 表格的服务端实现）
    business.py        业务数据来源边界（real 未接真实存储 → 503，不回退 Mock）
    mailer.py          SMTP（real 必须）/ capture（隔离开发与测试）
    bootstrap.py       受控初始化管理员（可审计，无公开注册入口）
  routers/             auth / me / admin / business（契约见 docs/development-stages/13-接口交接表.md）
migrations/            Alembic 迁移（0001 = 用户账户与注册审核模块）
docs/DB_FIELD_DICTIONARY.md  字段字典、表关系、约束与派生规则
tests/                 pytest：D01–D08、A 系列接口/协议用例、权限矩阵；隔离 PostgreSQL + 测试 OIDC + 邮件捕获
scripts/bootstrap_admin.py   初始管理员受控开通 CLI
```

## 本地运行

```bash
python3 -m venv .venv
./.venv/bin/pip install -r requirements.txt
# 配置：复制仓库根目录 .env.example 为 .env（稳定路径；环境变量优先，空值不覆盖默认）
# 统一启动（推荐，可重复）：在仓库根目录
npm run server:dev    # = bash server/scripts/start-dev.sh：配置校验→数据库/迁移检查→幂等迁移→启动
# 也可手动：
./.venv/bin/alembic upgrade head && ./.venv/bin/uvicorn app.main:app --reload --port 8000
```

readiness：`GET /readyz`（数据库连接 + 迁移版本 + 核心密钥；失败 503 并输出可定位日志）。liveness：`GET /healthz`（不代表注册可用）。

前端经同源代理 `/api/v1/*`（`next.config.mjs`）访问本服务；服务端页面门禁用 `API_INTERNAL_URL` 直连。

## 测试（必须使用隔离 PostgreSQL，不用内存 Mock 代替）

测试夹具（`tests/conftest.py`）会：

1. 在 `localhost:55432` 的 PostgreSQL（docker，见下）创建一次性数据库并执行真实迁移；
2. 启动隔离测试 OIDC 提供方（`tests/oidc_stub.py`，仅 pytest 进程内，**禁止出现在生产配置**）；
3. 使用 `MAIL_MODE=capture` 邮件捕获器读取验证码（生产禁用，无任何调试读码接口）。

```bash
# 一次性启动隔离 PostgreSQL（开发/测试用，与生产无关）
docker run -d --name gp-pg-test -e POSTGRES_USER=gp -e POSTGRES_PASSWORD=gp_test_pw \
  -e POSTGRES_DB=gp_test -p 55432:5432 postgres:16-alpine

./.venv/bin/python -m pytest tests/ -q      # 或仓库根目录：npm run server:test
```

覆盖范围：D01–D08（唯一约束、并发事务、失败回滚、持久化恢复、核验失效）、账号密码注册/登录（含枚举防护、限流、哈希存储、改密）、A01–A23 中可服务端验证的部分
（匿名 401、OAuth state/nonce/PKCE/重放、验证码一次性/限流、换绑、教师审核版本绑定、停用即撤销会话、
CSRF/Origin/returnTo、无提权、跨账号/跨课程/助教/管理员权限矩阵、故障不回退 Mock、real 模式配置强制）。
浏览器层验收由 `npm run check:auth` / `check:browser` 另行覆盖。

## 初始管理员（受控初始化）

无公开管理员注册入口。部署负责人在服务端执行（真实 sub 从 Google 登录日志/控制台获取）：

```bash
DATABASE_URL=... ./.venv/bin/python -m scripts.bootstrap_admin \
  --google-sub <Google OIDC sub> --name "管理员" --username admin01 --school-email admin@must.edu.mo
```

写入 users/auth_identities/school_email_bindings 并记录 `admin.bootstrapped` 审计。

## 上线检查清单

- `APP_MODE=real` 启动即校验：Google Client ID/Secret/Redirect URI、SMTP、HMAC 密钥、HTTPS、Google issuer；缺任一项**启动失败**。
- 生产禁止：演示账号、setRole 提权、固定/任意验证码、调试读码接口、邮件捕获器、Mock 数据回退。
- 全部业务接口先 `require_active_user` 再资源授权；当前业务数据来源未迁移（见下），对应接口在 real 模式返回 `SERVICE_UNAVAILABLE`。

## 未完成 / 未联调（如实标记）

1. **真实 Google OAuth 联调**：代码走完整 OIDC 协议（Authlib + PKCE + state/nonce + JWKS 验签），并已用隔离测试 OIDC 提供方验证确定性流程；尚未使用真实 Google Client 凭据联调（缺 `GOOGLE_CLIENT_ID/SECRET/REDIRECT_URI` 与控制台回调登记）。
2. **真实学校邮件投递**：SMTP 适配器已实现（发送失败返回 `AUTH_UNAVAILABLE`，不伪报成功）；尚未对可投递邮箱实测（缺 SMTP 凭据与学校发信策略确认）。
3. **业务数据表迁移**：课程/项目/任务/证据等业务实体仍在前端演示适配器；`app/routers/business.py` 的授权管线（会话+注册资格+资源权限）真实实现并被测试覆盖，数据来源 `services/business.py` 在 real 模式未接真实存储时返回 503（不回退 Mock）。迁移契约见 `docs/development-stages/13-接口交接表.md`。
4. **真实邮件投递（E21）未联调**：需 SMTP/事务邮件服务与允许的发件身份（`MAIL_MODE=smtp`、`SMTP_HOST/PORT/USER/PASSWORD`、`SMTP_TLS_MODE=starttls|implicit|none`、`MAIL_FROM`）；捕获器仅隔离环境。邮件故障只关闭依赖邮件的操作（注册/学校验证/重置返回 MAIL_UNAVAILABLE），不跳过验证、不阻断密码登录。
5. **真实 Google 联调**未做（缺 OAuth 客户端/回调登记）；未配置时入口经 capabilities 隐藏，不影响邮箱通道。
6. 密码账户与 Google 账户不自动合并，受控关联流程待设计。
7. **学校规则确认**：邮箱分配细节、学号格式与学号-邮箱对应关系（`STUDENT_ID_EMAIL_RULE` 保持 `none`）、学校实名核验接入（`academic_identity_checks` 已留表，首期不阻塞学生准入）。
