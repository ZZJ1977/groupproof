# GroupProof 分阶段开发与交付索引

> 更新日期：2026-11-27 · 代码基线：`origin/develop == origin/main`（Alembic 迁移头 `0047`）  
> 返回 [项目首页](../../README.md) · 另见 [前端实现状态](../../FRONTEND_STATUS.md) · [开发与架构设计](../guide/ARCHITECTURE.md)

## 当前总览与上线状态（2026-11-27）

本目录记录早期 V1 分阶段实施计划（阶段 01–15）及后续真实后端合流里程碑。截至 **2026-11-27**，**阶段 01–15 及 A/B/C/D 全部真实前后端模块均已完成开发、联调、压测并部署上线**：

- **Staging（`develop`）**：<https://groupproof-staging-production.up.railway.app>
- **Production（`main`）**：<https://groupproof-production-production.up.railway.app>
- **Admin Console（`admin-backend`，支持双环境切换）**：<https://web-production-650d4574.up.railway.app/admin>

当前系统已全面运行在统一 FastAPI 后端（`services/api/`，Alembic 头 `0047`）、PostgreSQL 18.6（`pgvector`、`pgcrypto`）、Redis + Celery Worker、100% 服务端认证（Argon2id + HttpOnly Session + CSRF + Brevo/Resend/SMTP 邮件 OTP + Google OIDC）以及真实外部集成（GitHub App/OAuth、飞书机器人、OpenRouter 双模型 AI、Supabase Storage + PG LOB 回退）之上；`shared/legacy-mock/` 仅保留作隔离测试夹具，线上环境强制关闭。

## 新贡献者 / AI 助手推荐阅读顺序

1. [项目协作规范 AGENTS.md](../../AGENTS.md)：协作流程、目录边界、核心业务不变量与本地运行避坑（含严禁 `source .env`）。
2. [项目首页 README.md](../../README.md)：产品定位、技术栈、7 分支分工与快速启动命令。
3. [开发与架构设计 ARCHITECTURE.md](../guide/ARCHITECTURE.md)：系统架构图、双轨验收与贡献 v2 流程图、目录树与 OpenAPI 同步流程。
4. [本地开发、测试与部署指引 LOCAL_AND_DEPLOY.md](../guide/LOCAL_AND_DEPLOY.md)：环境变量、第三方集成配置、前后端校验与三环境发布流程。
5. [前端实现状态 FRONTEND_STATUS.md](../../FRONTEND_STATUS.md)：最新上线总览、客观运行限制与近期交付记录。
6. [前端页面地图 FRONTEND_IMPLEMENTATION_PLAN.md](../architecture/FRONTEND_IMPLEMENTATION_PLAN.md)：56 个核心设计页 + 扩展页（`57–63`）+ 账户页路由规范。
7. [系统技术方案 TECHNICAL_PLAN.md](../architecture/TECHNICAL_PLAN.md) 与 [部署基线 DEPLOYMENT.md](../architecture/DEPLOYMENT.md)。
8. [并发压力测试与 AI 成本测算报告 STRESS_TEST_REPORT.md](../testing/STRESS_TEST_REPORT.md)。
9. 按任务领域查阅对应模块文档：[A 共享服务](../modules/a/A_SHARED_SERVICES.md) · [B 接口文档](../modules/b/B_INTERFACES.md) · [C 交付记录](../modules/c/C_DELIVERY.md)。

## 历史分阶段（01–15）与后续里程碑总表

> 说明：早期独立的 `01-*.md` 至 `15-*.md` 单阶段规格草案已在系统演进与代码重构过程中归并沉淀到各模块接口文档（`docs/modules/`）、架构规范（`docs/architecture/`、`docs/superpowers/`）与真实代码中；下表保留原阶段编号与最终完成态供追溯。

| 阶段 | 内容 | 前置阶段 | 最终状态 | 现网对应实现 |
| --- | --- | --- | --- | --- |
| 01 | 权限矩阵与权限判断 | 架构基线 | **已完成（已上线）** | 服务端 Contextual RBAC（`services/api/app/auth/` + 各模块鉴权）与助教细粒度权限 Hook（`teacher/hooks/`） |
| 02 | 版本模型与成员确认 | 01 | **已完成（已上线）** | 不可变快照与成员绑定确认（`baseline_versions`、`plan_versions`、`b_course_rule_versions`） |
| 03 | 业务命令与持久化 | 01、02 | **已完成（已上线）** | 统一 FastAPI 事务写入、`lock_version` 乐观锁与 `Idempotency-Key` 幂等控制 |
| 04 | 课程规则与模板 | 01–03 | **已完成（已上线）** | 教师课程规则草稿/发布与版本同步（`teacher/pages/TeacherRulesApiPage.tsx`、`b_course_rule_versions`） |
| 05 | 课程项目创建 | 01–04 | **已完成（已上线）** | 课程立项、独立立项（`/projects/new`）及一键移入课程（`POST /api/v1/projects/{id}/attach-course`） |
| 06 | 需求基线管理 | 01–05 | **已完成（已上线）** | 需求版本管理、冲突解决、成员确认与冻结快照（`student/projects/RequirementsApiPage.tsx`） |
| 07 | 项目初始化流程 | 05、06 | **已完成（已上线）** | 六步初始化向导与真实文档正文提取（`student/projects/ProjectSetupCenter.tsx`） |
| 08 | 任务规划与发布 | 03、06、07 | **已完成（已上线）** | 任务树/看板/列表共享数据、权重与依赖校验、责任确认与计划发布（`student/projects/PlanningApiPage.tsx`、`TasksApiPage.tsx`） |
| 09 | 课程规则变更处理 | 04、06、08 | **已完成（已上线）** | 课程规则真实差异比较、影响评估与组长适用确认（`student/review/CourseRulesApiPage.tsx`） |
| 10 | 项目资料与文件版本 | 01–03、05 | **已完成（已上线）** | Supabase Storage + PG LOB 回退、SHA-256 回执、不可变版本与课程资料互通 |
| 11 | 项目设置与生命周期 | 03、06、08、10 | **已完成（已上线）** | 项目设置、GitHub/飞书集成绑定、项目归档与重开（`student/review/ProjectSettingsApiPage.tsx`、`CourseReopenApiPage.tsx`） |
| 12 | 项目总览与统计 | 05–11 | **已完成（已上线）** | 公开/私有双视图总览与加权进度统计（`student/projects/ProjectOverviewPanels.tsx`） |
| 13 | 功能验收与后端接口交接 | 01–12 | **已完成（已上线）** | 唯一 OpenAPI 契约（[openapi.json](../../packages/domain/openapi.json)）与全生命周期后端测试 `tests/test_full_lifecycle_e2e.py` |
| 14 | UI/UX 重新设计 | 13 | **已完成（已上线）** | 教师 5-Hub 工作台重构、学生端统一开放画布（[设计规格](../superpowers/specs/2026-11-22-student-ui-unified-design.md)）与管理台刷新 |
| 15 | 动态交互与动效规范 | 14 | **已完成（已上线）** | Lucian UI 动效底座（`shared/styles/lux-*.css`、`shared/components/lux/`），Playwright UX 自检 24/24 通过（[自检报告](../testing/2026-11-25-ui-redesign-selfcheck.md)） |

## 后续核心演进里程碑（阶段 15 之后）

- **2026-10-12 至 2026-10-18（统一认证与 Google OIDC）**：身份服务并入 `services/api/app/auth`（迁移 `0013`、`0015–0016`），打通 Argon2id 密码、学校邮箱 OTP、Google 登录与账号安全关联，退役早期 `server/` 目录。
- **2026-11-12 至 2026-11-21（A/B/C/D 全模块真实化与外部集成）**：完成 GitHub App/OAuth 多分支同步、飞书机器人群聊绑定、OpenRouter AI 接入、Supabase Storage、C 证据/文件/讨论、D 完整性校验/AI 验收/风险巡检/7 章节报告真实导出（DOCX/PDF）及真实工作区演示数据清理。
- **2026-11-22（管理台真实治理与双环境切换）**：`admin-backend` 接入真实治理 API（用户目录、教师审核、课程治理、共享审计、OpenRouter 场景用量与临时只读授权）并合流主干，详见 [2026-11-22-admin-backend.md](stage-reports/2026-11-22-admin-backend.md)。
- **2026-11-22（GitHub AI 活动摘要迁移 `0047`）**：新增 `a_activity_summaries` 通用摘要服务与文件级 diff 同步。
- **2026-11-25 至 2026-11-27（Lucian UI、贡献 v2、压测与生产上线）**：合并 Lucian UI 改版，落地贡献分析 v2（5 维度、提交数与飞书聊天 0% 权重）与独立项目移入课程，完成并发压测与 AI 成本测算（[STRESS_TEST_REPORT.md](../testing/STRESS_TEST_REPORT.md)），Staging、Production 与 Admin Console 三环境全面上线。

## 新任务启动上下文模板

```text
请先依次阅读 AGENTS.md、README.md、docs/guide/ARCHITECTURE.md、
docs/guide/LOCAL_AND_DEPLOY.md 与 FRONTEND_STATUS.md。

当前代码基线为 origin/develop（Alembic 迁移头 0047，统一后端 services/api/）。
按本次任务需求核对相关代码与契约，遵循服务端 Contextual RBAC、乐观锁与幂等规范；
若改动 API Schema 需同步导出 packages/domain/openapi.json 并运行 npm run api:generate；
提交前完成受影响的前后端 lint / typecheck / pytest / check:routes 校验并记录验证结果。
```
