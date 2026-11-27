# 系统技术方案与实现基线

> 更新日期：2026-11-27 · 代码基线：`origin/develop == origin/main`（Alembic 迁移头 `0047`）  
> 返回 [项目首页](../../README.md) · 另见 [开发与架构设计](../guide/ARCHITECTURE.md) · [部署基线](DEPLOYMENT.md)

## 1. 生产技术栈选型（已落地）

GroupProof 已完成从前期前端原型到全栈生产系统的演进，以下为当前在 Staging、Production 与 Admin Console 实际运行的统一技术基线：

| 层级 | 现网技术选型 | 用途与落地范围 |
| --- | --- | --- |
| 产品形态 | **Web-only（响应式）** | 覆盖学生工作台、教师 5-Hub 工作台与管理员控制台 |
| 前端 | **Next.js 15 App Router + React 19 + TypeScript + Tailwind CSS v4 + Radix UI / shadcn + Lucian UI** | 统一壳层、粒子登录页、`MorphNav`、可搜索下拉、三语切换（`next-intl`：`zh-Hans` / `zh-Hant` / `en`）、TanStack Query |
| 后端 | **FastAPI + SQLAlchemy 2 + Pydantic v2 + Alembic（`0047`）** | 模块化单体（Modular Monolith），位于 `services/api/`，统一承载认证与 A/B/C/D 业务模块（早期 `server/` 已退役移除） |
| 主数据库 | **PostgreSQL 18.6（Railway） / PG 16–18（本地）** | 全量认证、课程、小组、项目、需求基线、计划、任务、证据、验收、贡献、报告、风险、审计与 AI 用量持久化 |
| 向量与加密扩展 | **`pgvector` + `pgcrypto`** | 启用向量扩展与数据库侧安全能力 |
| 文件存储 | **Supabase Storage + PostgreSQL LOB 回退** | 项目资料、课程资料、证据附件与报告导出产物存储，带 SHA-256 完整性校验 |
| 异步任务 | **Redis + Celery Worker + Risk Scheduler** | 7 章节报告异步生成与导出（DOCX / PDF / MD）、每日风险巡检与后台任务消费 |
| AI 引擎 | **OpenRouter + Provider Adapter + `a_ai_usage_events`** | 日常分析/匹配/验收/风险使用 `deepseek/deepseek-v3.2`；7 章节报告撰写与图表规划使用 `google/gemini-2.5-flash`；全量调用计费与 Token 遥测落库 |
| GitHub 集成 | **GitHub App + OAuth + 多分支同步** | 仓库绑定、多分支 Commit / PR / Diff / 文件变更同步、AI 提交摘要与个人 GitHub 身份归属 |
| 飞书集成 | **企业自建应用机器人 + 飞书 Open API** | 项目群校验绑定、群聊消息元数据同步与 AI 协作洞察（仅作过程参考，不直接折算贡献分） |
| 认证与安全 | **Argon2id + HttpOnly Session Cookie + CSRF + Google OIDC + 学校邮箱 OTP** | 100% 服务端认证；支持 `@student.must.edu.mo` / `@must.edu.mo` 验证码（Brevo / Resend / SMTP）、Google 登录与账号安全关联/解除 |
| 权限体系 | **服务端 Contextual RBAC** | Student / Leader / Teacher / TA（细粒度按课程授权，默认只读）/ Admin 按目标课程、小组与项目关系在服务端严格鉴权 |
| CI/CD | **GitHub Actions（6 项 Job）** | `quality`、`backend`、`e2e`、`c-integration`、`docker` 全部绿灯后自动触发 `deploy` |
| 部署平台 | **Railway 三环境** | Staging（`develop`）、Production（`main`）、Admin Console（`admin-backend`，支持双环境切换） |
| 测试体系 | **pytest + Playwright + 契约脚本** | 后端 PostgreSQL 单元/集成/全生命周期测试 + 前端 E2E + OpenAPI/路由/i18n/UI 契约校验 |

## 2. 系统分层

后端采用模块化单体架构，保持清晰的领域边界，前端、API、管理台与异步 Worker 作为独立 Railway 容器部署：

```text
Web 层          Next.js 15 App Router（student/、teacher/ 5-Hub、admin/、shared/）与 /api/v1 同源代理
API 层          FastAPI REST API、认证与 Contextual RBAC 中间件、幂等键与乐观锁控制
业务层          app/auth（身份）+ modules/a（共享与集成）+ modules/b（课程与计划）+ modules/c（执行与证据）+ modules/d（验收、贡献 v2、风险与报告）
集成层          GitHub App & OAuth、飞书 Open API、OpenRouter 双模型适配器、Brevo / Resend / SMTP 邮件服务
任务层          Redis + Celery report-worker + daily risk-scheduler + services/worker
数据层          PostgreSQL 18.6（pgvector / pgcrypto / Alembic 0047）
文件层          Supabase Storage（主）+ PostgreSQL LOB（回退）
运维层          Railway 三环境 + GitHub Actions 6 项 CI/CD 流水线
```

## 3. 核心业务机制设计

1. **双轨证据与人工确认闭环**：任务树、看板、列表共享同一 Task 实体；进度 100% 不自动提交；AI 逐条验收结果仅作为辅助判断，必须经人工确认写入 `formal_outcomes`；正式证据撤回或变更时在同事务内作废相关验收结论。
2. **贡献核算 v2（`formal-task-weight-cross-task-equal-split-v2`）**：正式贡献比例严格依据已确认的任务权重与跨任务分工计算并支持冻结快照与申诉裁定；界面多维对比呈现 5 个维度（**正式成果权重**、**任务完成进度**、**有效代码量**、**代码提交（参考，0% 权重）**、**飞书协作（参考，0% 权重）**）。
3. **独立项目与课程项目互通**：支持无课程独立立项，并可通过 `POST /api/v1/projects/{id}/attach-course` 在满足组长权限与课程成员校验的前提下将独立项目一键移入课程，保留历史资产并实时同步至教师工作台。
4. **7 章节结项报告与真实导出**：基于冻结基线、计划、正式证据与贡献快照，调用 `google/gemini-2.5-flash` 分段撰写 7 章节内容并规划可视化图表，支持在线编辑审批与真实 Markdown / Word (`.docx`) / PDF 导出。

## 4. 项目演进与交付阶段总结

| 阶段 | 核心目标 | 当前状态 |
| --- | --- | --- |
| 阶段一：V1 前端原型与路由基线 | 56 个核心设计页、角色导航、响应式布局、基础 Docker 与 CI/CD | **已完成** |
| 阶段二：统一认证与全模块后端持久化 | `services/api` 统一 FastAPI 认证（Argon2id / Session / CSRF / OIDC）、A/B/C/D 业务持久化与 Alembic `0001–0047`、Contextual RBAC、OpenAPI 强契约 | **已完成** |
| 阶段三：文件存储、异步队列与治理后台 | Supabase Storage + PG LOB 回退、SHA-256 校验、Redis + Celery 报告导出与风险巡检、独立双环境 Admin Console（用户/教师审核/课程/审计/AI 用量） | **已完成** |
| 阶段四：第三方集成与 AI 业务闭环 | Brevo/Resend/SMTP 邮件 OTP、Google OIDC、GitHub App/OAuth 多分支同步、飞书机器人协作洞察、OpenRouter 双模型分析/验收/7 章节报告与 DOCX/PDF 导出、贡献分析 v2 | **已完成** |
| 阶段五：界面升级与三环境生产上线 | 教师 5-Hub 工作台重构、学生端统一画布、Lucian UI 视觉与动效升级、并发压力测试与 AI 成本实测、Staging / Production / Admin Console 全量上线 | **已完成（现网运行中）** |

## 5. 当前仓库目录边界

实际代码按角色端与服务职责分区，未采用早期规划中的 `apps/` 拆分，以避免破坏现有 Railway 根目录构建与部署链路：

```text
app/                 Next.js App Router 路由、全局样式与 /api/v1 同源代理
student/             学生工作台（课程、项目、执行、评审、API 客户端）
teacher/             教师 5-Hub 工作台（页面、组件、图表、权限 Hook、API 客户端）
admin/               管理员治理控制台（页面、环境切换器、API 客户端）
shared/              跨角色壳层、基础与 Lucian UI 组件、认证、首页/收件箱、i18n、工具与 legacy-mock/
services/api/        统一 FastAPI 后端（app/auth + app/modules/{a,b,c,d} + migrations 0001–0047 + tests）
services/worker/     独立 Celery Worker 消费者脚手架
packages/domain/     OpenAPI 快照 (openapi.json) 与生成的 TS 类型 (api.generated.ts)
e2e/ · scripts/      Playwright 测试套件、工程契约校验与 Railway 部署脚本
```

## 6. 当前运行边界与已知限制（客观评估）

1. **单进程吞吐天花板（Railway Starter 资源规格）**：API 容器当前默认单进程 Uvicorn（`--workers 1`），在本地与 Staging 实测中可稳定承载 ~100 并发读用户（典型高校 30–60 人课堂安全无误），但在 150+ 并发写或重聚合查询突发下 P95 延迟会明显升高，具体量化曲线与优化路径（多 worker、连接池调整、`touch_session()` 写节流与聚合索引优化）见 [并发压力测试报告](../testing/STRESS_TEST_REPORT.md)。
2. **第三方 OpenRouter 配额、延迟与成本**：AI 分析、提交摘要与报告生成依赖外部 OpenRouter 可用性与配额，现网模型组合下标准小组全周期预计消耗 **RMB 2.3–5.8 / 组**（高频大 diff 仓库的 `summarize_activity` 重试是主要成本项），需结合 `/admin/ai-usage` 持续监控。
3. **兼容夹具保留范围**：`shared/legacy-mock/` 仅用于隔离单元测试、路由/权限静态断言与演示夹具；Staging 与 Production 通过构建与运行参数强制禁用，绝不作为生产数据源。
4. **自定义域名与 Google OAuth 公开验证**：现网三套环境目前运行于 Railway `.up.railway.app` 域名下；后续接入学校或项目正式自定义域名时，需同步完成域名绑定、Google OAuth 同意屏幕公开审核与邮件发信域名配置。
