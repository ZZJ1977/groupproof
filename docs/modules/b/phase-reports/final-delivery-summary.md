# GroupProof 教师端工作台（Phases 1–8）最终交付总报告

> **历史归档文档**：本文记录对应阶段的规划/验收快照，不代表当前最新状态；当前架构、实时交付状态与限制请以 [README.md](../../../../README.md) 与 [FRONTEND_STATUS.md](../../../../FRONTEND_STATUS.md) 为准。

- **交付日期**：2026-11-17
- **执行依据**：[2026-11-17-teacher-platform-execution.md](../2026-11-17-teacher-platform-execution.md)
- **分支状态**：本地工作区改造完成（未执行 `git commit` / `git push` 及 Docker 构建命令，由您本地自行迁移与重启容器）。

---

### 一、8 阶段建设总览

| 阶段 | 模块主题 | 核心页面 | 迁移版本 | 阶段报告 |
|---|---|---|---|---|
| Phase 1 | 权限引擎 + 助教与权限管理 | Screen 59 `/teacher/courses/{cid}/staff` | `0032` | [phase-1-staff-permissions-report.md](phase-1-staff-permissions-report.md) |
| Phase 2 | 班级设置中心 + 课程规则管理 | Screen 46 `/settings` · Screen 47 `/rules` | `0033` | [phase-2-settings-and-rules-report.md](phase-2-settings-and-rules-report.md) |
| Phase 3 | 审批与操作中心 + 导航待办徽标 | Screen 44 `/teacher/courses/{cid}/actions` | — | [phase-3-actions-center-report.md](phase-3-actions-center-report.md) |
| Phase 4 | 课程资料中心（目录树/版本/可见性） | Screen 50 `/teacher/courses/{cid}/files` | `0034` | [phase-4-course-files-report.md](phase-4-course-files-report.md) |
| Phase 5 | 课程公告系统 + 学生未读顶部横条 | Screen 60 `/announcements` · `AnnouncementBanner` | `0035` | [phase-5-announcements-report.md](phase-5-announcements-report.md) |
| Phase 6 | 数据报告中心（纯 SVG 看板 + 导出） | Screen 45 `/teacher/courses/{cid}/reports` | — | [phase-6-reports-center-report.md](phase-6-reports-center-report.md) |
| Phase 7 | 申诉与争议处理 + 贡献度调权快照 | Screen 49 `/teacher/courses/{cid}/appeals` | `0036` | [phase-7-appeals-report.md](phase-7-appeals-report.md) |
| Phase 8 | 项目总览督办 + 跨班级教师工作台 | Screen 61 `/projects` · Screen 58 `/teacher/dashboard` | — | [phase-8-projects-and-dashboard-report.md](phase-8-projects-and-dashboard-report.md) |

---

### 二、数据库迁移清单（连续单头 `0031 → 0036`）

Alembic 检查确认：`heads: ['0036']`，迁移链 `['0036', '0035', '0034', '0033', '0032', '0031']`。

1. **`0032_b_staff_permissions.py`**（32 行）：为 `course_staff` 增加 JSONB `permissions` 细粒度授权映射字段。
2. **`0033_b_course_rules.py`**（57 行）：为 `courses` 增加 `description`、`archived_at`，新建 `b_course_rule_versions` 不可变版本快照表。
3. **`0034_b_course_file_folders.py`**（147 行）：新建 `b_course_file_folders`、`b_course_material_items`、`b_course_material_versions`（完全独立于 C 模块 `c_course_files`）。
4. **`0035_b_announcements.py`**（88 行）：新建 `b_course_announcements` 与 `b_announcement_reads`（`uq_b_announcement_read` 唯一已读回执）。
5. **`0036_b_course_appeals.py`**（118 行）：新建 `b_course_appeals` 与 `b_course_appeal_decisions`（申诉及裁决/调权审计日志）。

---

### 三、核心新增代码清单与行数统计

#### 1. 后端模块（`services/api/app/modules/b/`，共 7,064 行含迁移）
- 权限引擎：`teacher_permissions.py`（96）
- 助教管理：`teacher_staff_schemas.py`（64）、`teacher_staff_service.py`（290）、`teacher_staff_router.py`（100）
- 课程规则：`teacher_rules_schemas.py`（98）、`teacher_rules_service.py`（345）、`teacher_rules_router.py`（82）
- 操作中心：`teacher_actions_schemas.py`（92）、`teacher_actions_service.py`（794）、`teacher_actions_router.py`（121）
- 课程资料：`teacher_files_schemas.py`（138）、`teacher_files_service.py`（719）、`teacher_files_router.py`（293）
- 课程公告：`teacher_announcements_schemas.py`（96）、`teacher_announcements_service.py`（476）、`teacher_announcements_router.py`（159）
- 数据报告：`teacher_reports_schemas.py`（161）、`teacher_reports_service.py`（654）、`teacher_reports_router.py`（90）
- 申诉处理：`teacher_appeals_schemas.py`（121）、`teacher_appeals_service.py`（691）、`teacher_appeals_router.py`（123）
- 项目督办：`teacher_projects_schemas.py`（58）、`teacher_projects_service.py`（329）、`teacher_projects_router.py`（60）
- 教师工作台：`teacher_dashboard_schemas.py`（63）、`teacher_dashboard_service.py`（269）、`teacher_dashboard_router.py`（40）
- 阶段迁移文件 `0032`–`0036`：32 + 57 + 147 + 88 + 118 = 442 行

#### 2. 教师端后端路由总数（73 个端点，含 Phases 1–8 新增 **62 个**端点 + 既有班级/广场 **11 个**）
- `/api/v1/teacher/classes/*`（17 端点：原班级/广场 11 + Phase 2 设置/生命周期 6）
- `/api/v1/teacher/classes/{cid}/staff*` & `my-permissions`（5 端点）
- `/api/v1/teacher/classes/{cid}/rules*`（5 端点）
- `/api/v1/teacher/classes/{cid}/actions*`（4 端点）
- `/api/v1/teacher/classes/{cid}/files*` + `/api/v1/courses/{cid}/materials*`（13 端点）
- `/api/v1/teacher/classes/{cid}/announcements*` + `/api/v1/me/announcements/unread` + `/api/v1/courses/{cid}/announcements/*/read`（8 端点）
- `/api/v1/teacher/classes/{cid}/reports/*`（8 端点，含 BOM CSV / Markdown 下载）
- `/api/v1/teacher/classes/{cid}/appeals*` + `/api/v1/courses/{cid}/appeals*`（6 端点）
- `/api/v1/teacher/classes/{cid}/projects*`（3 端点）
- `/api/v1/teacher/dashboard*`（4 端点）

#### 3. 自动化测试文件（`services/api/tests/test_b_teacher_*.py`）
- `test_b_teacher_classes_postgres.py`（575）、`test_b_teacher_staff.py`（289）、`test_b_teacher_rules.py`（250）、`test_b_teacher_actions.py`（215）、`test_b_teacher_files.py`（248）、`test_b_teacher_announcements.py`（176）、`test_b_teacher_reports.py`（281）、`test_b_teacher_appeals.py`（250）、`test_b_teacher_dashboard.py`（199）
- 同步更新迁移头断言：`test_readiness.py`、`test_database.py`、`test_c_auth_migration_compatibility.py`（均为 `"0036"`）。

#### 4. 前端页面、客户端、图表与公共组件（`groupproof/`）
- API Clients & Hooks：`teacher-client.ts`（275）、`teacher-staff-client.ts`（76）、`teacher-rules-client.ts`（97）、`teacher-actions-client.ts`（107）、`teacher-files-client.ts`（224）、`teacher-announcements-client.ts`（137）、`teacher-reports-client.ts`（174）、`teacher-appeals-client.ts`（117）、`teacher-projects-client.ts`（62）、`teacher-dashboard-client.ts`（62）、`use-teacher-permissions.ts`（63）
- 页面组件（全部接入真实后端，教师端 **15** 个 Screen `41..50, 57..61` 已全部在 `route-dispatcher.tsx` 完成实接）：
  - `TeacherDashboardApiPage.tsx`（222，Screen 58）
  - `TeacherClassesApiPage.tsx`（492，Screen 57）
  - `TeacherClassHomeApiPage.tsx`（209，Screen 41）
  - `TeamPlazaApiPage.tsx`（477，Screen 42）、`TeamCard.tsx`（229）、`StudentEntity.tsx`（180）
  - `TeacherGroupDetailApiPage.tsx`（384，Screen 43）、`GroupProgressBar.tsx`（101）
  - `TeacherActionsApiPage.tsx`（254，Screen 44）、`ActionFilterPanel.tsx`（120）、`ActionCard.tsx`（89）
  - `TeacherProjectsApiPage.tsx`（129，Screen 61）、`ProjectOverviewCard.tsx`（152）
  - `TeacherReportsApiPage.tsx`（263，Screen 45）+ `charts/{ProgressChart,MilestoneTimeline,RiskMatrix,ActivityRanking}.tsx`（248）
  - `TeacherSettingsApiPage.tsx`（529，Screen 46）
  - `TeacherRulesApiPage.tsx`（593，Screen 47）、`MilestoneTemplateEditor.tsx`（177）
  - `TeacherAppealsApiPage.tsx`（200，Screen 49）、`AppealDetailPanel.tsx`（242）
  - `TeacherFilesApiPage.tsx`（804，Screen 50）
  - `TeacherAnnouncementsApiPage.tsx`（431，Screen 60）、`features/b/AnnouncementBanner.tsx`（107）
  - `TeacherStaffApiPage.tsx`（379，Screen 59）
  - 共享壳与侧栏：`TeacherClassLayout.tsx`（224）、`ClassRosterSidebar.tsx`（232）、`InviteCodeCard.tsx`（120）、`StudentProfileDrawer.tsx`（172）
- 导航、路由与国际化改造：`lib/routes.ts`、`features/b/screens.ts`、`features/route-dispatcher.tsx`、`lib/ux/navigation.ts`、`components/workspace-shell.tsx`、`features/b/CoursesApiPages.tsx`、`features/c/DailyApiPages.tsx`、`messages/{zh-Hans,zh-Hant,en}.json`、`lib/i18n/catalog/{en,zh-Hant}.ts`、`packages/domain/{openapi.json,api.generated.ts}`。

---

### 四、全局集成最终校验结果（最新实测输出）

| # | 校验命令 | 结果 | 最新实测细节 |
|---|---|---|---|
| V1 | `ruff check groupproof/services/api/` | ✅ pass | `All checks passed!` |
| V2 | `ruff format --check groupproof/services/api/` | ✅ pass | `357 files already formatted` |
| V3 | `pytest -c .../pyproject.toml ... groupproof/services/api/tests -x -q` | ✅ pass | **1035 passed, 363 skipped**（SQLite 隔离夹具全通；Postgres 专测按无 `DATABASE_URL` 默认跳过） |
| V4 | `npm --prefix groupproof run typecheck` | ✅ pass | `tsc --noEmit` exit 0 |
| V5 | `npm --prefix groupproof run lint` | ✅ pass | `eslint .` exit 0 |
| V6 | `npm --prefix groupproof run check:routes` | ✅ pass | 已核对 56 个设计页与路由 |
| V7 | `npm --prefix groupproof run check:ux` | ✅ pass | UX 定向复核回归通过：22 项断言 |
| V8 | `npm --prefix groupproof run check:e2e` | ✅ pass | 功能验收端到端走查通过：40 项断言 |
| V9 | `npm --prefix groupproof run check:i18n` | ✅ pass | `zh-Hans / zh-Hant / en` 共 **822 个键**核对通过 |
| V10 | `npm --prefix groupproof run check:ui-catalog` | ✅ pass | `features/teacher/`、`AnnouncementBanner.tsx`、`workspace-shell.tsx` 缺失词条数为 **0**（其余输出均为既有 C 模块存量页面与客户端） |
| V11 | `npm --prefix groupproof run build` | ✅ pass | `next build` 生产构建成功（exit 0，于沙箱外执行） |
| 迁移检查 | Alembic `ScriptDirectory` | ✅ pass | `heads: ['0036']`, `chain: ['0036', '0035', '0034', '0033', '0032', '0031']` |

---

### 五、本地 Docker 启动与上线注意事项

1. **执行数据库迁移**：本地重启后端后务必执行 Alembic 升级至 `0036`，使 `0032`–`0036` 新增表与字段就绪：
   ```bash
   docker compose exec api alembic upgrade head
   ```
2. **重建镜像**：因前端新增页面与后端路由均已扩充，本地启动时建议重新构建 `api` 与 `web` 容器镜像再启用（确保 `.env` 中 `NEXT_PUBLIC_ENABLE_MOCKS=false` 或按 `bworkspace=real` 开启真实接口）。
3. **已知边界说明**：当前交付验证依托后端全量 `pytest`、OpenAPI 契约生成、前端静态门禁（V4–V10）与 Next.js 生产构建（V11）；浏览器端人工点击巡检（Live Docker E2E）可在您本地启动容器后按各阶段报告中的 E 编号逐项点击复核。
