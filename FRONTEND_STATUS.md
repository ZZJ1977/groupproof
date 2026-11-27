# GroupProof 前端与全栈交付状态

> 更新日期：2026-11-27 · 代码基线：`origin/develop == origin/main`（Alembic 迁移头 `0047`）  
> 返回 [项目首页](README.md) · 另见 [开发与架构设计](docs/guide/ARCHITECTURE.md) · [部署基线](docs/architecture/DEPLOYMENT.md)

## 当前生产交付总览（2026-11-27）

GroupProof 已完成全角色前端页面、统一 FastAPI 后端、PostgreSQL 持久化与第三方集成上线，三套 Railway 环境均在线运行（HTTP 200），前端强制关闭 Mock（`NEXT_PUBLIC_APP_MODE=real`、`NEXT_PUBLIC_ENABLE_MOCKS=false`）：

| 维度 | 当前实态 |
| --- | --- |
| **线上环境** | **Staging**（`develop`）：<https://groupproof-staging-production.up.railway.app><br>**Production**（`main`）：<https://groupproof-production-production.up.railway.app><br>**Admin Console**（`admin-backend`，支持双环境切换）：<https://web-production-650d4574.up.railway.app/admin> |
| **后端与数据库** | 统一 FastAPI（`services/api/`，原 `server/` 已退役移除）、SQLAlchemy 2、Alembic 头 **`0047`**、Railway 托管 **PostgreSQL 18.6**（`pgvector`、`pgcrypto`）、Redis + Celery Worker（`report-worker`、`risk-scheduler`、`services/worker/`） |
| **认证与权限** | 100% 服务端认证（`services/api/app/auth/`）：Argon2id 密码散列、HttpOnly 会话 Cookie + CSRF、Brevo / Resend / SMTP 学校邮箱 OTP（`@student.must.edu.mo` / `@must.edu.mo`）、Google OIDC 登录与账号关联、服务端 Student / Teacher / TA / Admin Contextual RBAC；**零 `localStorage` 演示鉴权** |
| **前端架构与 UI** | Next.js 15 App Router、React 19、TypeScript、Tailwind CSS v4、Radix UI / shadcn 风格控件、TanStack Query、`next-intl`（简/繁/英 1243 键），按 `app/`、`student/`、`teacher/`（5-Hub 重构）、`admin/`、`shared/` 分区；**Lucian UI 改版**（粒子登录页、`MorphNav`、侧栏动效、可搜索下拉、语言选择器）已合入 `develop` 与 `main` 上线 |
| **已上线外部集成** | GitHub App + OAuth 多分支 Commit/PR/Diff 同步与 AI 摘要；飞书机器人群聊同步与 AI 协作洞察；OpenRouter AI（`deepseek/deepseek-v3.2` 日常分析/验收/风险 + `google/gemini-2.5-flash` 7 章节结项报告与图表，`a_ai_usage_events` 全量计费遥测）；Supabase Storage + PostgreSQL LOB 文件存储回退；真实 Markdown / DOCX / PDF 报告导出 |
| **核心业务亮点** | 贡献分析 v2（`formal-task-weight-cross-task-equal-split-v2`，5 维呈现含「有效代码量」，提交次数与飞书群聊 0% 权重）与贡献快照冻结；独立项目一键移入课程（`POST /api/v1/projects/{id}/attach-course`）与教师端实时互通；全局权限隔离搜索（`GET /api/v1/search`） |

## 当前限制（客观运行边界）

以下为当前生产系统经实测确认的客观边界，不作掩饰或夸大：

1. **单进程 Uvicorn / Railway Starter 吞吐上限**：当前 API 容器以单 worker（`--workers 1`）运行，典型高校课堂（~100 并发读用户以内）安全稳定；在 150+ 并发写或重聚合读突发场景下 P95 延迟将显著上升。详细量化指标、连接池行为与扩容优化方案（多 worker + `touch_session()` 节流 + 复合索引）见 [并发压力测试报告](docs/testing/STRESS_TEST_REPORT.md)。
2. **第三方 OpenRouter AI 配额、延迟与成本依赖**：需求分析、GitHub 活动摘要、飞书协作洞察、AI 验收与 7 章节报告依赖 OpenRouter 上游可用性与响应时间；现网配置下标准软件工程小组全周期预计消耗 **RMB 2.3–5.8 / 组**（高并发大 diff 仓库触发 `summarize_activity` 重试会推高费用），需配合 `/admin/ai-usage` 监控异常调用。
3. **`shared/legacy-mock/` 保留范围**：仓库内的 `shared/legacy-mock/` 目录仅保留作隔离单元测试、路由/权限静态断言与演示夹具使用，**并非**生产数据源；Staging 与 Production 在构建期与运行期均强制禁用。
4. **公网域名与 Google OAuth 公开审核**：当前三套环境运行在 Railway 分配的 `.up.railway.app` 域名下；切换至自定义正式域名时，需同步完成域名绑定、Google OAuth 同意屏幕公开验证与对应发信域名配置。
5. **UI 与窄屏已知细项**：全站现行主题仅保留浅色模式（未启用暗色主题）；历史自检记录了两项待后续迭代打磨的细节——教师主操作色 `#3370ff` 白字对比度 `4.28:1`，以及 `teacher/pages/TeacherClassHomeApiPage.tsx` 在 `375px` 窄屏下的标题换行，详见 [UI 改版自检报告](docs/testing/2026-11-25-ui-redesign-selfcheck.md)。

## 当前目录结构与工程验证命令

```text
app/                 Next.js App Router 路由入口、全局样式 (globals.css) 与 /api/v1 同源代理
student/             学生工作台（courses / projects / execution / review / api / ux）
teacher/             教师 5-Hub 工作台（pages / components / charts / hooks / api）
admin/               管理员治理控制台（pages / components / lib / api）
shared/              跨角色壳层、基础与 Lucian UI 组件 (components/lux, auth/lux, styles/lux-*)、认证、收件箱、i18n、lib、types、legacy-mock/
services/api/        统一 FastAPI 后端（app/auth + app/modules/{a,b,c,d} + migrations 0001–0047 + tests）
services/worker/     Celery 后台任务框架
packages/domain/     OpenAPI 快照 (openapi.json) 与生成的 TS 类型 (api.generated.ts)
e2e/ · scripts/      Playwright 套件、工程契约检查与 Railway 部署脚本
```

常用验证命令（详见 [本地开发、测试与部署指引](docs/guide/LOCAL_AND_DEPLOY.md)）：

- 前端与契约：`npm run lint`、`npm run typecheck`、`npm run build`、`npm run check:routes`（`CHECK_HTTP=1` 校验匿名鉴权语义）、`npm run check:i18n`、`npm run check:ui-catalog`、`npm run check:workspace-isolation`、`npm run check:student-ui`、`npm run check:admin-ui`、`npm run check:admin-pages`。
- 后端：`cd services/api && ruff format --check app migrations scripts tests && ruff check app migrations scripts tests && alembic upgrade head && alembic check && PYTHONPATH=. pytest -q`。
- E2E：`npm run test:e2e`、`npm run test:e2e:teacher`、`npm run test:workspace-real`。

---

## 近期关键交付记录

### 2026-11-25 至 2026-11-27：Lucian UI 改版合流、贡献分析 v2 与生产环境全面上线

- **Lucian UI 改版已合入 `develop` 与 `main` 上线**：引入 `shared/styles/lux-tokens.css`、`lux-shell.css`、`lux-student.css`、`lux-teacher.css` 及 `shared/auth/lux/ParticleWordmark`、`shared/components/lux/{FloatingField,MorphNav,JellyActionRow,language-picker,search-autocomplete}`，全量支持 `prefers-reduced-motion: reduce` 静态降级。Playwright UX 自检在 `1440px`/`1024px`/`768px`/`375px` 与减弱动效模式下 **24/24 通过**（详见 [UI 改版自检报告](docs/testing/2026-11-25-ui-redesign-selfcheck.md)）；`npm run check:i18n` 三语 1243 键与 `CHECK_HTTP=1 npm run check:routes`（56 页 + `/projects` + `/admin`）全部通过。
- **贡献分析 v2 与多维对比**：正式核算公式升级为 `formal-task-weight-cross-task-equal-split-v2`（收紧跨任务代码归属精度）；前端多维对比图提供 **正式成果权重 / 任务完成进度 / 有效代码量 / 代码提交（参考，0%）/ 飞书协作（参考，0%）** 5 个维度。
- **并发压测、AI 成本测算与双环境同步**：完成本地 PG16 阶梯读/锁竞争/突发混测与 Railway Staging 公网并发压测，结合 `a_ai_usage_events` 实测账单完成成本建模（[并发压力测试与 AI 成本测算报告](docs/testing/STRESS_TEST_REPORT.md)）；`main` 生产环境与 `develop` Staging 环境完成同步部署，三套 Railway 环境全部在线。

### 2026-11-22：原工作区统一、全流程闭环、学生统一画布与双环境管理台

- **统一主干与 Admin 工作台合流**：合流 `develop` 与 `admin-backend`，`/admin` 分配独立页面编号 `62`（教师扩展页为 `57–61`，学生我的项目页为 `63`），管理台通过顶部环境选择器切换 Staging 与 Production 真实数据。
- **全局权限隔离搜索**：新增 `GET /api/v1/search`，顶栏搜索框替换禁用态，按当前用户真实上下文权限检索课程、项目、任务、证据与文件。
- **课程资料互通与项目初始化正文提取**：学生端 `/courses/:courseId/files` 联通教师端课程资料与规则版本；打通 `.pdf`/`.docx`/`.md`/`.txt` 分段提取（`PersistedMaterialTextPort`）与内联提取回退路由。
- **贡献冻结、CSRF 加固与真实 DOCX/PDF 导出**：新增 `POST /api/v1/projects/{id}/contribution/freeze`；统一加固 D 模块 `fetchWithSession` CSRF 携带；升级真实 DOCX/PDF 报告导出渲染器；新增 12 阶段全生命周期端到端后端测试 `tests/test_full_lifecycle_e2e.py`。
- **学生端统一工作台与 GitHub AI 活动摘要（迁移 `0047`）**：开放画布与按需详情抽屉覆盖首页、动态与活动页；新增 `a_activity_summaries` 表与 `activity-summary-v1` 通用摘要服务，首屏展示提交者与 AI 实现摘要（明确标注 `AI 已生成 · 待人工确认`），详情抽屉展示文件级差异与原始来源。
- **管理后台治理接线**：接入账号目录、教师审核、课程治理、共享审计（`/api/v1/admin/shared-audit-events`）、OpenRouter 场景用量统计与临时只读授权；新增 `scripts/check-admin-ui.mjs` 与 `scripts/check-admin-pages.mjs`。

### 2026-11-21：独立项目、真实工作区清理、GitHub/飞书与学校邮箱注册闭环

- **独立项目与移入课程**：新增 `/projects/new` 独立立项与 `POST /api/v1/projects/{id}/attach-course` 移入课程链路，详见证据 [学生端入口复核](docs/plans/2026-11-21-student-entry-audit.md) 与 [工作区功能恢复说明](docs/plans/2026-11-21-workspace-function-restoration.md)。
- **演示数据彻底隔离与清理**：Staging 与 Production 无条件关闭 Mock，真实工作区自动清除遗留本地演示键；完成 Staging 历史种子数据清理并建立 `npm run check:workspace-isolation` 守卫。
- **GitHub 与飞书真实集成**：项目设置统一管理 GitHub App 仓库绑定与飞书 `oc_...` 群聊校验绑定；个人中心支持 GitHub OAuth 授权绑定与作者归属映射。
- **学校邮箱注册与资料页改版**：先验证学校邮箱再进入 `/register/profile` 补全资料与密码（最低 8 字符、Argon2id 散列）；登录限流增加服务端倒计时冷却。

### 2026-10-06 至 2026-11-19：早期原型到统一后端演进摘要（历史归档）

| 日期 | 里程碑 | 关键产出 |
| --- | --- | --- |
| 2026-10-06 | V1 前端原型、阶段 01–15 规格与 UX 基线 | 落地 56 页路由映射、权限资格矩阵、版本与成员确认模型、命令执行器与基础 UX/动效规范 |
| 2026-10-08 – 10-10 | 早期身份服务与三语国际化 | 引入 FastAPI + PostgreSQL 身份闭环、注册进度四态、三语 `next-intl` 与页面级路由门禁 |
| 2026-10-11 – 10-15 | 统一认证整合（PR #14）与 C 模块真实持久化 | 认证迁入 `services/api/app/auth`（迁移 `0013`），退役早期 `server/`；C 模块任务执行、证据、讨论、文件与治理接入真实 PostgreSQL API（详见 [C 交付记录](docs/modules/c/C_DELIVERY.md)） |
| 2026-10-18 | Google OIDC 登录与账号关联 | 新增回调同源校验、失败统一回登录页、邮箱冲突检测与安全关联/解除（迁移 `0015–0016`） |
| 2026-11-12 – 11-19 | A/B/C/D 跨模块联调与文件校验 | 贯通 A 共享服务（[A_SHARED_SERVICES.md](docs/modules/a/A_SHARED_SERVICES.md)）、B 课程与教师 5-Hub 接口（[B_INTERFACES.md](docs/modules/b/B_INTERFACES.md)）、C 文件 SHA-256 回执与 D 任务验收/证据作废事务联动 |
