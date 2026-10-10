# GroupProof 代码审查与修复记录

日期：2026-10-10。范围：本地最新项目相对远程 `feat/B_task`（基点 `4a12ae3f69049550e1fd20fb6919a914697fb68f`）的交付代码，重点为身份认证、注册、个人中心、业务版本操作和提交完整性。

用户点名的 Code Review 插件当前可调用接口面向已有 PR 的 CI 诊断；本任务没有指定 PR。本次采用本地源码审查、缺陷复现、修复及回归检查，不能描述为已取得插件或远程 CI 的通过结果。

## 已确认并修复的问题

| 优先级 | 问题与影响 | 修复与证据 |
|---|---|---|
| P1 | OAuth 事务没有绑定发起浏览器，另一个浏览器可使用攻击者发起的回调进入攻击者账户。 | 发起时设置 HttpOnly、SameSite=Lax 的事务 Cookie，回调先核对浏览器绑定，成功后删除；跨浏览器拒绝及合法回调/重放回归。见 `server/app/routers/auth.py`。 |
| P1 | 用户正常修改密码后，旧密码重置令牌仍可再次重设密码。 | 改密增加凭据版本、作废恢复挑战和旧会话，当前浏览器取得新会话；覆盖旧恢复令牌与旧会话拒绝。见 `server/app/routers/me.py`。 |
| P1 | 已批准教师换绑学校邮箱后，旧角色可继续绕过当前审核依据。 | 资格以当前资料快照的有效批准为准；换绑验证后撤销失效教师身份、降回受限会话。见 `server/app/services/registration.py`、`email_challenges.py`。 |
| P2 | 学校邮箱旧地址确认接口缺失导入且未持久保存换绑目标，过了近期认证窗口后换绑无法完成。 | 验证码挑战绑定本次目标地址；有效旧邮箱确认只授权该目标一次。增加迁移 `0004`。 |
| P2 | 改密/邮箱验证轮换会话后，个人中心仍使用旧 CSRF；根布局未传 session 还导致语言偏好写入分支不执行。 | 各轮换操作后读取当前会话并同步上下文；接纳服务端新会话 props；语言偏好使用当前 Cookie 对应的 CSRF。 |
| P2 | 停用账号的 `/me` 只返回精简状态，但页面按完整资料渲染，可能崩溃。 | 四个个人中心页面在访问完整字段前统一呈现停用状态；登入保持禁用。 |
| P2 | 密码注册且未绑定 Google 的账号仍显示 Google 绑定卡片。 | 依据 `googleEmailBound` 显示卡片。 |
| P2 | 计划、基线和课程草稿保存不更新所校验的父级版本，旧草稿可覆盖新编辑。 | 成功保存同步递增项目/课程版本；回归验证旧版本被拒绝且首个编辑保留。 |
| P2 | 解锁/重新发布计划把旧快照的进度、状态和验收结果覆盖到执行数据。 | 解锁读取当前投影；发布保留最新执行事实，变化的任务定义/标准使旧验收过期，未变标准的人工确认保留。 |

后端四个安全场景的回归文件：`server/tests/test_review_security_regressions.py`。业务回归分别加入 `scripts/check-plan.mjs`、`check-baseline.mjs`、`check-course-rules.mjs`。

## 验证结果

- `GROUPPROOF_ENV_FILE=/dev/null ./.venv/bin/python -m pytest tests/ -q`：122 passed。每轮创建随机隔离 PostgreSQL 数据库，使用本地 OIDC stub 和邮件捕获器，不触及真实邮件与开发用户数据。
- `npm run lint`、`npm run typecheck`：通过。
- `npm run build`：通过，含 standalone 输出及 `/healthz`。
- 路由检查：56 个设计页映射通过；i18n 检查：三语 470 个键及参数结构一致。
- 业务规则检查：access、versioning、commands、course-rules、project-create、baseline、setup、plan、rule-change、files、lifecycle、overview、e2e、ux 通过。其中新增修复相关的 plan 为55项、baseline为49项、course-rules为44项。
- `npm run check:account-review`：通过。使用独立生产构建、真实 Chrome 和内存身份接口，覆盖四个停用账号页面、未绑定 Google 的资料展示、两次连续改密、轮换后的语言偏好保存与退出，确认没有过期 CSRF 请求。该检查验证前端契约，不代替后端真实 PostgreSQL 测试。

## 提交与运行说明

- 本地原 Git 历史仅包含文档，且未设置 remote。提交基于远程现有 `feat/B_task` 历史建立，不强推，不改写 main/develop。
- 保留远程 Dockerfile、CI、健康检查、public 目录和部署文档，恢复 standalone 构建及 Node 20 可用的 tsx 检查入口。新鉴权下匿名页面检查依赖身份服务，因此 CI quality job 增加隔离 PostgreSQL、后端测试及 smoke test 期间的身份服务；此工作流尚未在远程执行。
- 新增忽略规则，排除 `.env`、依赖、编译产物、Python 虚拟环境、缓存及本地临时密令记录；发布文档中的本地密令值已移除。
- 后端新增迁移 `0004`：部署/启动新后端前，按现有启动流程执行 `alembic upgrade head`（`npm run server:dev` 已包含迁移）。本次只对隔离测试库执行了迁移，未迁移用户现有开发数据库。
- 远程现有 CI 仅在 main/develop push 或手动触发时运行；本次仅更新功能分支，不部署、不发起合并。

## 验证边界

课程、项目、任务等业务数据仍为浏览器本地演示适配器，真实业务持久化尚未完成；此审查没有把它升级为多用户生产后端。真实 Google 服务、学校邮件投递和生产部署未在本次重新联调。测试中可见依赖弃用告警及 next-intl 的构建缓存分析告警，不影响本次测试/构建通过；后续依赖升级另行处理。
