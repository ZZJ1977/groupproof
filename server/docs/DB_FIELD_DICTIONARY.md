# 用户账户与注册审核模块：数据库字段字典

更新日期：2026-10-08。对应迁移：`server/migrations/versions/0001_user_account_and_registration.py`（Alembic，PostgreSQL）。
字段语义按实施方案 §7.3/§7.4；表名/列名可按后端命名约定调整，**字段语义与约束不得弱化**。

图例：申报=用户填写（可编辑）；事实=验证/审核流程写入（普通接口禁止写入）；派生=由当前事实计算，不落库。

## 表关系

```text
users 1 ──── n auth_identities            （Google 身份绑定；provider+issuer+subject 唯一）
users 1 ──── 1 school_email_bindings      （学校邮箱绑定；已验证规范邮箱全局唯一）
users 1 ──── n academic_identity_checks   （实名/学籍字段核验记录；保留历史）
users 1 ──── n sessions                   （可撤销会话；token 只存摘要）
users 1 ──── n email_challenges           （邮箱验证码挑战；HMAC 存储；每账户/用途一个当前挑战）
users 1 ──── n teacher_applications       （教师审核申请；绑定资料快照版本）
users 1 ──── n auth_audit_events          （审计；actor/target 引用）
oauth_transactions                       （Google OIDC 事务：state/nonce/PKCE，一次性）
auth_rate_limits                         （跨进程限流计数）
email_outbox                             （邮件捕获，仅非 real 模式）
```

## users（用户档案）

| 字段 | 类型 | 来源 | 说明与约束 |
|---|---|---|---|
| id | varchar(64) PK | 服务端 | 内部 userId；不使用学号/邮箱作主键 |
| name | varchar(120) 可空 | 申报 | 姓名；Unicode、去首尾空白、1–80 字符；修改会使依赖核验结论过时 |
| username | varchar(64) 可空 | 申报 | 2–32 位 `[A-Za-z0-9_-]`；展示用 |
| username_normalized | varchar(64) 可空，**UNIQUE** | 服务端 | 去首尾空白 + ASCII 小写；唯一性由数据库兜底（D03） |
| student_id | varchar(64) 可空 | 申报 | 学号；格式按 `STUDENT_ID_PATTERN`（默认仅禁止空白、4–20 位）；**非登录主键、不作身份绑定** |
| college | varchar(120) 可空 | 申报 | 学院；不是激活门槛 |
| requested_identity | varchar(16) 可空 | 申报 | `student`/`teacher` 申请意向；**不能写入 roles** |
| roles | json（数组） | 事实 | 正式角色 `student/teacher/ta/admin`，只能由服务端流程授予：学生激活授予 `student`；教师审核批准授予 `teacher`；助教由课程教师授权；管理员由受控初始化 |
| account_status | varchar(16) | 事实 | `enabled`/`disabled`；停用由管理员接口写入并即时撤销会话 |
| disabled_reason / disabled_at | text / timestamp | 事实 | 停用原因与时间 |
| preferred_locale | varchar(16) 可空 | 申报 | `zh-Hans`/`zh-Hant`/`en`；PATCH /me/preferences 写入 |
| auth_version | int | 事实 | 资格/敏感权限版本；角色授予/撤销、停用时 +1；旧会话（auth_version 不符）不再代表当前资格 |
| version | int | 事实 | 乐观并发（`expectedVersion`）；资料修改 +1 |
| created_at / updated_at / last_login_at | timestamp | 事实 | last_login_at 同时作为“近期重新认证”依据（换绑前置） |

未提交注册时申报字段可空；**完整性由 RegistrationFacts 判断，不由 NOT NULL 保证**（方案 §7.3）。

## auth_identities（外部身份绑定）

| 字段 | 类型 | 来源 | 说明与约束 |
|---|---|---|---|
| id | varchar(64) PK | 服务端 | |
| provider | varchar(32) | 事实 | 固定 `google` |
| issuer | varchar(255) | 事实 | OIDC issuer（Google：`https://accounts.google.com`） |
| subject | varchar(255) | 事实 | Google `sub`；**身份唯一键 = provider+issuer+subject（UNIQUE）**；邮箱不是主键 |
| user_id | FK → users.id（RESTRICT） | 事实 | 与 User 同事务创建（D01） |
| google_email | varchar(255) 可空 | 事实 | Google 邮箱；与学校邮箱分开保存 |
| created_at / last_authenticated_at | timestamp | 事实 | |

## school_email_bindings（学校邮箱绑定）

| 字段 | 类型 | 来源 | 说明与约束 |
|---|---|---|---|
| user_id | FK → users.id（CASCADE）PK | 事实 | 每人一个当前绑定 |
| school_email / school_email_normalized | varchar(255) 可空 | 事实 | 已验证学校邮箱及规范值（小写）；**normalized 全局 UNIQUE**（D03） |
| verified_at / verification_method | timestamp / varchar | 事实 | 验证时间与依据（`email_code`；受控初始化可为 `documented_manual_review`） |
| pending_school_email / pending_school_email_normalized / pending_requested_at | 可空 | 申报 | 待验证地址（首次注册或换绑）；**不占用唯一名额** |
| change_authorized_until / change_authorized_target | 可空 | 事实 | 旧邮箱一次性确认签发的换绑授权（10 分钟、绑定精确目标） |
| updated_at | timestamp | 事实 | |

换绑规则（§5.2/§6.3）：旧已验证邮箱在新邮箱验证前继续有效；新地址验证成功后**原子替换**；失败/取消不覆盖原地址。换绑前置要求近 10 分钟重新认证，或旧邮箱对指定目标的一次性确认；二者均未落地时不开放换绑（保留旧地址与正常登录）。

## pre_registration_requests（注册前验证事务，2026-10-09 新增）

先证明登录邮箱归属、再限时一次性建档；不依赖 users 外键，验证前不创建永久账户/不占用户名。

| 字段 | 类型 | 来源 | 说明与约束 |
|---|---|---|---|
| id | varchar(64) PK | 事实 | 高熵事务 ID |
| email / email_normalized | varchar(255) | 申报 | 登录邮箱（允许 QQ 等普通邮箱）及比较值 |
| locale | varchar(16) | 申报 | 邮件模板语言 |
| browser_token_digest | varchar(128) | 事实 | 浏览器事务 Cookie 摘要（全部步骤绑定同一浏览器） |
| code_hmac | varchar(128) 可空 | 事实 | 验证码 HMAC（独立密钥；不存明文） |
| generation | int | 事实 | 重发递增；旧码随 HMAC 替换失效 |
| expires_at / attempts | timestamp / int | 事实 | 10 分钟（可配）；最多 5 次；**失败次数显式提交，不随错误响应回滚** |
| send_status | varchar(16) | 事实 | pending/accepted/failed/unknown；“发件被接受”≠邮箱已验证 |
| resend_available_at | timestamp | 事实 | 60 秒冷却；每邮箱 5/小时、20/日，IP 另限 |
| code_consumed_at | timestamp 可空 | 事实 | 验证码一次性消费时间 |
| creation_grant_digest | varchar(128) 可空，**部分唯一** | 事实 | 建档资格摘要（≥256 位随机，只存摘要；10 分钟有效、一次性） |
| creation_grant_expires_at / completed_at / result_user_id | | 事实 | 资格期限；建档完成时间与结果账户（幂等“已完成请登录”） |
| invalidated_at | timestamp 可空 | 事实 | 修改邮箱/取消/过期清理时作废 |

留存策略：未完成事务过期 24 小时后脱敏（清空邮箱/验证码/资格），仅保留必要审计/限流记录（`pre_registration.cleanup_expired`）。

## password_credentials（账号密码凭据，2026-10-08 新增）

| 字段 | 类型 | 来源 | 说明与约束 |
|---|---|---|---|
| user_id | FK → users.id（CASCADE）PK | 事实 | 每账户至多一套密码凭据；与 auth_identities（Google）分开管理，不自动合并账户 |
| login_email / login_email_normalized | varchar(255)，**normalized UNIQUE** | 申报 | 登录邮箱（独立于学校邮箱）；唯一性数据库兜底（D03 同原则） |
| password_hash | varchar(255) | 事实 | bcrypt（cost 12）；**绝不存明文/可逆密文，不出现在任何响应/日志/审计** |
| password_algo | varchar(32) | 事实 | `argon2id`（新设/重置）/ `bcrypt`（历史，验证兼容并在成功登录后升级） |
| login_email_verified_at | timestamp 可空，2026-10-09 | 事实 | 登录邮箱归属验证时间；**历史行保持空=未验证**（不得借其取得 full 会话/找回密码） |
| verification_evidence_ref | varchar(255) 可空 | 事实 | 验证依据引用（注册前事务 ID/补验 challenge ID） |
| credential_version | int，server_default 1 | 事实 | 改密/重置递增；恢复凭据绑定此版本（版本不符拒绝） |
| created_at / password_changed_at / updated_at | timestamp | 事实 | 改密记录时间并轮换当前会话 |

登录标识 = `users.username_normalized`（用户名）或本表 `login_email_normalized`（邮箱）；未知用户与错误密码返回同一 `INVALID_CREDENTIALS`（含等价校验，不泄露账户存在性），服务端限流 5 次/15 分钟（按标识）+ 20 次/15 分钟（按 IP）。密码策略：新设/重置 15–128 字符（Argon2id，允许长口令/空格/粘贴 + 本地常见弱口令拦截）；历史 bcrypt 保留原验证语义。密码注册/登录同样进入注册闭环（onboarding 会话 → 资料 → 学校邮箱验证 → 教师审核）。

## academic_identity_checks（实名/学籍字段核验）

| 字段 | 类型 | 来源 | 说明与约束 |
|---|---|---|---|
| id | varchar(64) PK | 事实 | |
| user_id | FK → users.id（CASCADE） | 事实 | |
| checked_fields | json | 事实 | 核验字段范围（如 `["name","studentId"]`）；部分字段通过≠整档通过 |
| snapshot | json | 事实 | 核验时的字段快照/版本 |
| method | varchar(32) | 事实 | `school_sso`/`authorized_roster`/`documented_manual_review` |
| result | varchar(16) | 事实 | `passed`/`failed` |
| evidence_ref | varchar(255) 可空 | 事实 | 受限证据引用，不含材料本体 |
| checked_by / checked_at | varchar / timestamp | 事实 | |
| superseded_at | timestamp 可空 | 事实 | 依赖字段（姓名/学号/学校邮箱）变更后标记过时，**保留历史**（D07） |

派生 `academicIdentityStatus`：无记录=`unverified`；有未过时记录按最新 `passed→verified / failed→rejected`；全部过时=`stale`。
**首期准入不要求该记录**：学生凭资料 + 学校邮箱验证激活；界面不得显示“学校实名已核验”。

## sessions（应用会话）

| 字段 | 类型 | 来源 | 说明与约束 |
|---|---|---|---|
| id | varchar(64) PK | 事实 | |
| token_digest | varchar(128) **UNIQUE** | 事实 | Cookie 只保存不可解释随机 token；数据库保存 SHA-256 摘要 |
| csrf_token | varchar(128) | 事实 | 会话绑定 CSRF token（写操作校验 + Origin） |
| user_id | FK → users.id（CASCADE） | 事实 | |
| scope | varchar(16) | 事实 | `onboarding`/`full`/`status_only`；scope 不覆盖当前资格，每次请求仍重查 RegistrationFacts |
| auth_version | int | 事实 | 与 users.auth_version 比对；不符即失效 |
| created_at / last_seen_at | timestamp | 事实 | |
| expires_at | timestamp | 事实 | 闲置期限（onboarding 30 分钟 / full 2 小时 / admin 30 分钟，可配置） |
| absolute_expires_at | timestamp | 事实 | 绝对期限（12 小时 / 7 天 / 12 小时，可配置）；refresh 不能延长 |
| revoked_at / revoke_reason | timestamp / varchar | 事实 | 注销、轮换、停用时撤销（A14/A15） |

轮换时机：首次认证、受限转 active、敏感权限变化（auth_version 变化）；旧会话同时失效。Cookie 属性：`__Host-gp_session`（real）/`gp_session`（dev），`HttpOnly; SameSite=Lax; Path=/`，real 强制 `Secure` 且不设 Domain。

## email_challenges（学校邮箱验证码）

| 字段 | 类型 | 来源 | 说明与约束 |
|---|---|---|---|
| id | varchar(64) PK | 事实 | challengeId；校验绑定 userId+精确邮箱+用途 |
| user_id | FK → users.id（CASCADE） | 事实 | |
| email / email_normalized | varchar(255) | 事实 | 目标邮箱（服务端读取的待验证地址/旧邮箱） |
| purpose | varchar(32) | 事实 | `school_email_verify`/`change_authorization`（分开消费、分开限流） |
| code_hmac | varchar(128) | 事实 | 6 位密码学随机码的 HMAC-SHA256（服务端密钥）；**不存明文** |
| expires_at | timestamp | 事实 | 10 分钟（可配置） |
| attempts | int | 事实 | 最多 5 次；失败也持久计数（不随请求回滚） |
| consumed_at / invalidated_at | timestamp 可空 | 事实 | 一次性消费；重发/改目标/取消换绑作废旧挑战 |
| send_status | varchar(16) | 事实 | `accepted`=SMTP/捕获器已接受发送请求（不代表已投递）/`failed` |
| resend_available_at | timestamp | 事实 | 重发冷却 60 秒 |
| created_at | timestamp | 事实 | |

唯一性：部分唯一索引 `uq_email_challenge_active (user_id, purpose) WHERE consumed_at IS NULL AND invalidated_at IS NULL`——每个账户/用途最多一个可消费的当前挑战；并发重发由该约束 + 行锁兜底（A07/D08）。
限流：账号与邮箱各 5 次/小时、20 次/日，IP 另行较宽限制；计数表 `auth_rate_limits` 跨进程一致，返回 429 + `Retry-After`。

## teacher_applications（教师审核申请）

| 字段 | 类型 | 来源 | 说明与约束 |
|---|---|---|---|
| id | varchar(64) PK | 事实 | |
| user_id | FK → users.id（CASCADE） | 事实 | 每账户最多一条 pending（同资料幂等；资料变化重新提交绑定新快照） |
| application_version | int | 事实 | 提交时 users.version；审核用 expectedVersion 校验（A11） |
| snapshot | json | 事实 | 审核依据快照：`{name, requestedIdentity, schoolEmailNormalized}` |
| status | varchar(16) | 事实 | `pending`/`approved`/`rejected` |
| reviewer_id / reviewed_at / reason | varchar / timestamp / text | 事实 | 审核人、时间、对本人可见的原因 |
| created_at | timestamp | 事实 | |

审核只对当前快照生效：依赖资料变化后旧批准不沿用，服务端**撤销 teacher 角色并要求重新审核**（§5.2，D07）。

## auth_audit_events（审计）

| 字段 | 类型 | 来源 | 说明与约束 |
|---|---|---|---|
| id | varchar(64) PK | 事实 | |
| event_type | varchar(64) | 事实 | 如 `auth.login`、`email_challenge.sent`、`teacher_application.approved`、`user.disabled`、`admin.bootstrapped` |
| actor_id / target_user_id | varchar(64) | 事实 | |
| request_id | varchar(64) | 事实 | 与响应头 X-Request-Id 对应 |
| result | varchar(16) | 事实 | `success`/`failure` |
| changed_fields | json | 事实 | **只记录字段名**；不记录 token、验证码、完整邮箱 |
| created_at | timestamp | 事实 | |

## oauth_transactions（Google OIDC 事务）

| 字段 | 类型 | 说明 |
|---|---|---|
| state_digest | varchar(128) PK | state 摘要；一次性 + 10 分钟超时，抗回调重放（A03） |
| nonce / code_verifier | varchar | OIDC nonce 与 PKCE S256 verifier |
| return_to | varchar(512) 可空 | 经白名单校验的站内 returnTo |
| created_at / expires_at / consumed_at | timestamp | |

## auth_rate_limits / email_outbox

- `auth_rate_limits(bucket_key, window_start, count)`：`(bucket_key, window_start)` UNIQUE；跨进程限流计数。
- `email_outbox`：**仅 `MAIL_MODE=capture`（非 real）** 的邮件捕获记录，供隔离测试读取验证码；SMTP 模式不写入，防止验证码进入日志/存储。

## RegistrationFacts（派生 DTO，不建表）

`profileComplete`、`profileFieldErrors`、`schoolEmailVerified`、`teacherReviewStatus`、`academicIdentityStatus`、`verificationBasis`、`accountState`、`nextAction`——全部由当前事实计算（`server/app/services/registration.py`），**客户端不可写**。

派生优先级（§3.2）：`disabled → profile_required → email_required → review_* → active`；教师还需当前快照的管理员批准。

`verificationBasis` 分别记录实际完成的核验：`google_auth`（Google 账号认证）、`school_email_control`（学校邮箱控制权验证）、`teacher_approval`（教师人工批准），**不用一个 verified 布尔混合表达**。

## 三层检查（§7.2）落点

| 层次 | 实现 | 结果含义 |
|---|---|---|
| 格式与完整性 | `security.py`（姓名/用户名/邮箱精确域名/学号规则）+ `registration.profile_field_errors` | 仅表示输入符合要求 |
| 一致性与唯一性 | 数据库唯一约束：`username_normalized`、`(provider,issuer,subject)`、`school_email_normalized`；冲突返回 `USERNAME_CONFLICT`/`EMAIL_CONFLICT`，失败事务整体回滚（D03/D08） | 记录符合约束、避免重复绑定；**不自动合并账户** |
| 身份真实性 | 邮箱验证码（一次性、HMAC、限流）、教师人工审核、（未来）学校身份系统/授权名册写入 `academic_identity_checks` | 只证明实际检查过的属性；未实施的核验保持 `unverified` |

## 配置占位与未确认的学校规则

- 配置占位见根目录 `.env.example`（DATABASE_URL、GOOGLE_*、SMTP_*、EMAIL_CHALLENGE_HMAC_KEY 等）；真实值只放部署环境。
- **未确认、不得臆造**：学校邮箱分配规则细节、学号格式与“学号 ↔ 邮箱本地部分”对应关系（`STUDENT_ID_EMAIL_RULE=none` 保持不强制）、学校实名核验接入方式。确认后仅需收紧 `security.py` 校验与本字典，不影响已存记录的追溯。
- 业务数据（课程/项目/任务/证据）表不在本模块；边界与迁移待办见 `server/README.md` 与 `docs/development-stages/13-接口交接表.md`。

## 2026-10-10 审查补充（迁移 0004）

`email_challenges.change_target_email_normalized`：可空字符串（255），仅旧学校邮箱确认挑战使用，绑定用户在该次发码前申请的新学校邮箱。消费挑战后只为该地址签发一次性换绑授权；不可在验证码验证时替换为其他目标。
