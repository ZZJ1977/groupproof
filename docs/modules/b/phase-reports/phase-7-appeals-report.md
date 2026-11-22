# Phase 7 校验报告：申诉与争议处理

- **完成日期**：2026-11-17
- **覆盖范围**：Screen 49（`/teacher/courses/{cid}/appeals`，对标钉钉"审批仲裁与贡献度调权"）

---

### 一、实现清单

#### 后端与数据库
- [x] `services/api/app/modules/b/models.py`（修改）：新增 `BCourseAppeal`（`b_course_appeals`）与 `BCourseAppealDecision`（`b_course_appeal_decisions`）。
- [x] `services/api/migrations/versions/0036_b_course_appeals.py`（新增，118 行）：迁移 `0036`（`down_revision = "0035"`），创建申诉与裁决决策历史表。
- [x] `services/api/app/modules/b/teacher_appeals_schemas.py`（新增，121 行）：申诉摘要、补充材料、关联任务与 GitHub 提交证据、贡献度快照上下文、裁决调权 DTO。
- [x] `services/api/app/modules/b/teacher_appeals_service.py`（新增，691 行）：学生发起申诉并自动为具审权限教师/助教创建 `ActionItem`（`category="appeal"`）；学生补充说明流转；教师详查（关联 `Task`、`GithubActivity` 提交数与最新 `ContributionSnapshot`）；裁决受理支持同步调权并生成新冻结 `ContributionSnapshot`（保留原有只读快照历史），自动关闭关联 `ActionItem`（设置 `status` / `closed_at` / `closed_by`）并向申诉人发送通知。
- [x] `services/api/app/modules/b/teacher_appeals_router.py`（新增，123 行）：挂载教师端 3 个申诉裁决端点及学生端 3 个提交/补充/查询端点。
- [x] `services/api/app/modules/b/teacher_actions_service.py`（修改）：申诉待办跳转链接附带 `?appeal={id}` 精确定位参数。
- [x] `services/api/app/modules/b/router.py` & `teacher_classes_service.py`（修改）：挂载 `teacher_appeals_router`，并在 `delete_class` 补充空班申诉及决策级联清理。
- [x] `services/api/tests/test_readiness.py`、`test_database.py`、`test_c_auth_migration_compatibility.py`（修改）：迁移头版本更新为 `0036`。
- [x] `services/api/tests/test_b_teacher_appeals.py`（新增，250 行）：覆盖学生发起申诉 → 操作中心联动呈现 → `approve_changes` 助教权限拦阻 → 关联任务与 GitHub 提交回溯 → 要求补充与学生补交 → 受理调权并生成冻结 `v2` 快照与关闭待办全链路。

#### 前端与国际化
- [x] `lib/api/teacher-appeals-client.ts`（新增，117 行）：封装申诉列表、上下文详情与裁决调权客户端。
- [x] `features/teacher/AppealDetailPanel.tsx`（新增，242 行）：申诉详情、补充说明、关联任务、GitHub 提交计数、贡献度调权表单与决策时间线组件。
- [x] `features/teacher/TeacherAppealsApiPage.tsx`（新增，200 行）：Screen 49 申诉处理中心视图，支持 `?appeal=<id>` 定位预选、状态标签过滤及 `useTeacherPermissions` `approveChanges` 门控。
- [x] `features/b/screens.ts`、`features/route-dispatcher.tsx`、`lib/ux/navigation.ts`、`features/teacher/TeacherClassLayout.tsx`（修改）：注册 Screen 49 并接入「申诉处理」导航入口。
- [x] `messages/{zh-Hans,zh-Hant,en}.json`、`lib/i18n/catalog/{en,zh-Hant}.ts`（修改）：新增 `nav.teacher.appeals` 及全部 28 条申诉多语言词条。
- [x] `packages/domain/openapi.json`、`packages/domain/api.generated.ts`（自动重新生成）。

---

### 二、校验结果（V1–V11）

| # | 检查项 | 结果 | 备注 |
|---|---|---|---|
| V1 | `ruff check` | ✅ pass | `All checks passed!` |
| V2 | `ruff format --check` | ✅ pass | `350 files already formatted` |
| V3 | `pytest`（本阶段专项 + 全量） | ✅ pass | `test_b_teacher_appeals.py`: 1 passed；全量: **1034 passed, 363 skipped** |
| V4 | `npm run typecheck` | ✅ pass | exit 0 |
| V5 | `npm run lint` | ✅ pass | exit 0 |
| V6 | `npm run check:routes` | ✅ pass | 已核对 56 个设计页与路由 |
| V7 | `npm run check:ux` | ✅ pass | 22 项断言全部符合预期 |
| V8 | `npm run check:e2e` | ✅ pass | 40 项断言全部符合预期 |
| V9 | `npm run check:i18n` | ✅ pass | `zh-Hans / zh-Hant / en` 共 821 个键核对通过 |
| V10 | `npm run check:ui-catalog` | ✅ pass | `features/teacher/` 与 `AnnouncementBanner.tsx` 缺失词条数为 **0** |
| V11 | `npm run build` | ✅ pass | `next build` 生产构建成功（exit 0，沙箱外构建） |
| 额外 | Alembic 迁移链检查 | ✅ pass | `heads: ['0036']`, `top6: ['0036', '0035', '0034', '0033', '0032', '0031']` |

---

### 三、Verify-Diagnose-Fix 修复循环记录

- **循环 1（后端约束）**：
  - V3 失败：裁决完成更新关联 `ActionItem` 状态为 `completed` 时触发 `ck_a_action_items_closed` 检查约束（要求非 `pending` 状态必须同时填充 `closed_at`）。
  - 修正写入 `ai.closed_at = ts` 与 `ai.closed_by = user.id` 后，V1–V11 全部一次性通过。

---

### 四、效果验证（代码级 + 自动化测试 + 静态构建检查）

- [x] **E7-01**：`/teacher/courses/{cid}/appeals` 支持按 `all`/`pending`/`need_supplement`/`handled` 状态筛选展示申诉清单 ✅
- [x] **E7-02**：详查页完整加载申诉人名下任务列表、GitHub 提交数及当前最新贡献度快照 ✅
- [x] **E7-03**：支持「驳回」「要求补充材料」「受理/调权」全套状态流转与学生补交后重启待审核 ✅
- [x] **E7-04**：接受申诉并提交调权占比后，自动写入新的 `ContributionCalculation` 与冻结态 `ContributionSnapshot`（版本号递增为 `v2`） ✅
- [x] **E7-05**：每次裁决均向申诉学生发送站内 `Notification` 并更新关联待办状态，`test_b_teacher_appeals.py` 已查表验证 ✅

---

### 五、遗留问题

- 无（进入 Phase 8：项目总览 + 教师工作台）。
