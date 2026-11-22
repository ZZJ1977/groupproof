# Phase 8 校验报告：项目总览 + 教师工作台

- **完成日期**：2026-11-17
- **覆盖范围**：Screen 61（`/teacher/courses/{cid}/projects`，单班项目总览与督办）+ Screen 58（`/teacher/dashboard`，跨班级钉钉式教师工作台）

---

### 一、实现清单

#### 后端（Module B，不新增数据库表）
- [x] `services/api/app/modules/b/teacher_projects_schemas.py`（新增，58 行）：定义小组项目卡片、详情、逾期里程碑与催办请求 DTO。
- [x] `services/api/app/modules/b/teacher_projects_service.py`（新增，329 行）：按班级列出全部 `ProjectGroup`（区分已立项与未立项队伍，聚合任务进度、`milestone_briefs`、D 模块风险级别与最近 GitHub/进度事件时间），并提供详查与组内全员催办通知（`POST .../remind`）。
- [x] `services/api/app/modules/b/teacher_projects_router.py`（新增，60 行）：挂载 3 个班级项目总览与催办端点。
- [x] `services/api/app/modules/b/teacher_dashboard_schemas.py`（新增，63 行）：跨班级汇总统计、班级卡片、待办聚合、全局风险与近期动态 DTO。
- [x] `services/api/app/modules/b/teacher_dashboard_service.py`（新增，269 行）：限定 `teacher`/`ta` 角色权限，跨名下授课及执教班级汇总待处理事项数、学生与队伍数、进度、风险等级及前 20/50 条跨班教学活动流（公告/申诉/进度/GitHub）。
- [x] `services/api/app/modules/b/teacher_dashboard_router.py`（新增，40 行）：挂载 `/api/v1/teacher/dashboard` 及其 `/actions`、`/risks`、`/activity` 4 个端点。
- [x] `services/api/app/modules/b/router.py`（修改）：挂载 `teacher_projects_router` 与 `teacher_dashboard_router`。
- [x] `services/api/tests/test_b_teacher_dashboard.py`（新增，199 行）：覆盖已立项/未立项队伍混排、组员项目催办通知、学生访问 `/teacher/dashboard` 返回 `403` 拦截、跨多班级教师聚合及无授课班级教师隔离。

#### 前端与国际化
- [x] `lib/api/teacher-projects-client.ts`（新增，62 行）& `lib/api/teacher-dashboard-client.ts`（新增，62 行）：封装班级项目总览与全局工作台 API 客户端。
- [x] `features/teacher/ProjectOverviewCard.tsx`（新增，152 行）：区分渲染已立项项目卡片（分色进度条、风险标识、任务与里程碑数、进入项目/发送催办）与未立项灰色虚线卡片（引导进入组队广场/催促立项）。
- [x] `features/teacher/TeacherProjectsApiPage.tsx`（新增，129 行）：Screen 61 班级项目总览页，支持按全部/已立项/未立项/风险预警筛选。
- [x] `features/teacher/TeacherDashboardApiPage.tsx`（新增，222 行）：Screen 58 教师工作台总控台（4 个跨班核心 KPI 卡、授课班级快捷卡片、跨班待办清单与全局风险/近期动态流）。
- [x] `lib/routes.ts`、`features/b/screens.ts`、`features/route-dispatcher.tsx`、`lib/ux/navigation.ts`、`features/teacher/TeacherClassLayout.tsx`、`components/workspace-shell.tsx`（修改）：注册 Screen 58（`/teacher/dashboard`）与 Screen 61（`/teacher/courses/{cid}/projects`），在侧边栏全局及班级外路由置顶「教师工作台」入口，同时保证班级内 `aside nav` 严格保持班级Scoped链接（兼容 `c-shell-api.spec.ts`）。
- [x] `messages/{zh-Hans,zh-Hant,en}.json`、`lib/i18n/catalog/{en,zh-Hant}.ts`（修改）：新增 `nav.teacher.projects` 与工作台/项目总览 38 条多语言词条。
- [x] `packages/domain/openapi.json`、`packages/domain/api.generated.ts`（自动重新生成）。

---

### 二、校验结果（V1–V11）

| # | 检查项 | 结果 | 备注 |
|---|---|---|---|
| V1 | `ruff check` | ✅ pass | `All checks passed!` |
| V2 | `ruff format --check` | ✅ pass | `357 files already formatted` |
| V3 | `pytest`（本阶段专项 + 全量） | ✅ pass | `test_b_teacher_dashboard.py`: 1 passed；全量: **1035 passed, 363 skipped** |
| V4 | `npm run typecheck` | ✅ pass | exit 0 |
| V5 | `npm run lint` | ✅ pass | exit 0 |
| V6 | `npm run check:routes` | ✅ pass | 已核对 56 个设计页与路由 |
| V7 | `npm run check:ux` | ✅ pass | 22 项断言全部符合预期 |
| V8 | `npm run check:e2e` | ✅ pass | 40 项断言全部符合预期 |
| V9 | `npm run check:i18n` | ✅ pass | `zh-Hans / zh-Hant / en` 共 822 个键核对通过 |
| V10 | `npm run check:ui-catalog` | ✅ pass | `features/teacher/`、`AnnouncementBanner.tsx`、`workspace-shell.tsx` 缺失词条数为 **0** |
| V11 | `npm run build` | ✅ pass | `next build` 生产构建成功（exit 0，沙箱外构建） |

---

### 三、Verify-Diagnose-Fix 修复循环记录

- **循环 1（测试夹具）**：
  - V3 初始收集后报错：`ProjectGroup` ORM 模型不含 `min_size`/`max_size`/`created_by` 字段（群人数限制归属于 `Course`）。
  - 修正测试夹具为 `ProjectGroup(id=uuid4(), course_id=world.course_id, name="待立项新队")` 后，复验 V1–V11 全量一次通过。

---

### 四、效果验证（代码级 + 自动化测试 + 静态构建检查）

- [x] **E8-01**：`/teacher/courses/{cid}/projects` 返回全班队伍项目进度、完成任务、逾期里程碑与风险标签，`TeacherProjectsApiPage` 正常渲染 ✅
- [x] **E8-02**：`ProjectOverviewCard` 对未立项小组呈现虚线灰卡并提供「进入组队广场」与「催促立项」操作 ✅
- [x] **E8-03**：`POST .../projects/{group_id}/remind` 向组内全员投递 `[项目催办]` / `[立项催办]` 站内通知，`test_b_teacher_dashboard.py` 验证通过 ✅
- [x] **E8-04**：`/api/v1/teacher/dashboard` 聚合教师名下多班级学生、小组、项目、高/中风险及最近跨班动态 ✅
- [x] **E8-05**：`TeacherDashboardApiPage` 授课班级卡片直接指向 `/teacher/courses/{courseId}` 班级首页 ✅
- [x] **E8-06**：`workspace-shell.tsx` 为教师/助教在全局视图顶部呈现「教师工作台」（`/teacher/dashboard`）与「我的班级」（`/teacher/courses`）导航 ✅
- [x] **E8-07**：`/api/v1/teacher/dashboard/actions` 跨所有班级聚合未处理 `pending` 操作项并按优先级排序 ✅

---

### 五、遗留问题

- 无（全部 8 阶段开发与全局集成校验已完成）。
