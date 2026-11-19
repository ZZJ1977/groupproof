# Phase 1 校验报告：权限引擎 + 助教管理

- **完成日期**：2026-11-17
- **覆盖范围**：Screen 59（`/teacher/courses/{cid}/staff`，对标钉钉"子管理员权限"）+ 细粒度助教权限引擎

---

### 一、实现清单

#### 后端与数据库
- [x] `services/api/app/db/models/core.py`（修改）：`CourseStaff` 新增 `permissions`（`JSON().with_variant(JSONB(), "postgresql")`，默认值 `{}`）
- [x] `services/api/migrations/versions/0032_b_staff_permissions.py`（新增，32 行）：迁移 `0032`，为 `course_staff` 添加 `permissions` 列（`down_revision = "0031"`）
- [x] `services/api/app/modules/b/teacher_permissions.py`（新增，96 行）：`ALL_PERMISSIONS`、`effective_permissions`、`has_staff_permission`、`require_staff_permission`、`require_course_owner`
- [x] `services/api/app/modules/b/teacher_staff_schemas.py`（新增，64 行）：`StaffPermissionsDTO`、`StaffMemberDTO`、`StaffListDTO`、`InviteStaff`、`UpdatePermissions`、`RemoveStaff`、`MyPermissionsDTO`
- [x] `services/api/app/modules/b/teacher_staff_service.py`（新增，290 行）：`list_staff`、`invite_staff`、`update_permissions`、`remove_staff`、`my_permissions`
- [x] `services/api/app/modules/b/teacher_staff_router.py`（新增，100 行）：挂载 5 个端点（含 `Idempotency-Key` 幂等控制）
- [x] `services/api/app/modules/b/teacher_classes_service.py`（修改）：`plaza`、`create_group`、`assign`、`set_leader` 接入 `manage_groups` 细粒度权限
- [x] `services/api/app/modules/b/router.py`（修改）：挂载 `teacher_staff_router`
- [x] `services/api/tests/test_readiness.py`、`test_database.py`、`test_c_auth_migration_compatibility.py`（修改）：迁移头版本更新为 `0032`
- [x] `services/api/tests/test_b_teacher_staff.py`（新增，289 行）：3 组集成用例覆盖邀请校验、默认只读拦截、动态授权、成员移出及重新邀请重置权限

#### 前端与国际化
- [x] `lib/api/teacher-staff-client.ts`（新增，76 行）：助教管理 API 客户端与 Query Keys
- [x] `lib/hooks/use-teacher-permissions.ts`（新增，63 行）：`useTeacherPermissions(courseId)` 权限感知 Hook
- [x] `features/teacher/TeacherStaffApiPage.tsx`（新增，379 行）：Screen 59 页面（教职列表、6 项细粒度权限配置弹窗、按邮箱邀请、带原因确认移出）
- [x] `lib/routes.ts`、`features/b/screens.ts`、`features/route-dispatcher.tsx`（修改）：注册 Screen 59（保留原 Screen 51–56 给 `/admin/*`）
- [x] `lib/ux/navigation.ts`、`components/workspace-shell.tsx`（修改）：`teacherNavItems` 添加 `staff`（`userCog`）
- [x] `features/teacher/TeacherClassLayout.tsx`、`TeamPlazaApiPage.tsx`、`TeacherGroupDetailApiPage.tsx`、`ClassRosterSidebar.tsx`（修改）：接入 `useTeacherPermissions` 条件控制
- [x] `messages/{zh-Hans,zh-Hant,en}.json`、`lib/i18n/catalog/{en,zh-Hant}.ts`（修改）：新增全部中文词条及多语言映射
- [x] `packages/domain/openapi.json`、`packages/domain/api.generated.ts`（自动重新生成）

---

### 二、校验结果（V1–V11）

| # | 检查项 | 结果 | 备注 |
|---|---|---|---|
| V1 | `ruff check` | ✅ pass | `All checks passed!` |
| V2 | `ruff format --check` | ✅ pass | `322 files already formatted` |
| V3 | `pytest`（本阶段专项 + 全量） | ✅ pass | `test_b_teacher_staff.py`: 3 passed；全量: **1023 passed, 363 skipped**（PostgreSQL 需外部库跳过） |
| V4 | `npm run typecheck` | ✅ pass | exit 0 |
| V5 | `npm run lint` | ✅ pass | exit 0 |
| V6 | `npm run check:routes` | ✅ pass | 已核对 56 个设计页与路由 |
| V7 | `npm run check:ux` | ✅ pass | 22 项断言全部符合预期 |
| V8 | `npm run check:e2e` | ✅ pass | 40 项断言全部符合预期 |
| V9 | `npm run check:i18n` | ✅ pass | `zh-Hans / zh-Hant / en` 共 817 个键核对通过 |
| V10 | `npm run check:ui-catalog` | ✅ pass | Phase 1 新增/修改文件缺失数为 **0**（全库仅余 C/绑定模块既有 257 处） |
| V11 | `npm run build` | ✅ pass | `next build` 生产构建成功 |
| 额外 | Alembic 迁移链检查 | ✅ pass | `heads: ['0032']`, `top3: ['0032', '0031', '0030']` |

---

### 三、Verify-Diagnose-Fix 修复循环记录

- **循环 1**：
  - V1 失败：`teacher_classes_service.py` 导入排序 `I001`，`test_b_teacher_staff.py` 第 85 行超 100 字符 → 调整导入顺序并换行。
  - V2 失败：`teacher_staff_service.py` 需格式化 → 运行 `ruff format`。
  - V3 失败：`tests/b_fixtures._user` 缺少必填关键字参数 `now`，且 `pytest` 未传 `services/api/tests` 目录导致误扫 `services/worker/tests` → 补传 `now=datetime.now(UTC)` 并以 `services/api/tests` 运行。
  - V4 失败：`en.ts` / `zh-Hant.ts` 新增词条中有 3 个既有重复键 → 删除重复键。
  - V10 失败：`TeacherStaffApiPage.tsx` 存在 1 处模板字符串和拼接中文 → 改用 `tr("权限：{0}", ...)` 与 `tr("加入时间：{0}", ...)` 并补充翻译。
- **循环 2**：
  - V3 失败：`b_api(b_engine)` 为 contextmanager 且 `session.commit()` 后触发 `DetachedInstanceError` → 改为 `with b_api(b_engine) as api:` 并提前读取 `email`。
- **循环 3**：
  - V3 失败：`test_ta_permissions_toggle_enforced_on_group_actions` 调用 `assign` 未携带目标组 `lock_version` 返回 `409 VERSION_CONFLICT` → 传入 `to_group_version` 后 3/3 用例全绿；`next build` 改用标准宿主节点权限后构建成功。

---

### 四、效果验证

- [x] **E1-01**: 访问 `/teacher/courses/{cid}/staff` 正常渲染「助教管理」页面与邀请表单 ✅
- [x] **E1-02**: `POST .../staff/invite` 校验邮箱与教师/助教角色，新助教 6 项权限默认全 `False`（含大小写不敏感匹配与 404/409/422 边界）✅
- [x] **E1-03**: `PATCH .../staff/{uid}/permissions` 支持独立开关 6 项权限并发送通知与审计日志 ✅
- [x] **E1-04**: 前端各操作区域已接入 `useTeacherPermissions(courseId)` 条件控制 ✅
- [x] **E1-05**: 助教未授权 `manage_groups` 时调用分组写接口返回 `403 PERMISSION_DENIED`，授权后立即放行 ✅
- [x] **E1-06**: `POST .../staff/{uid}/remove` 立即撤销 `my-permissions` 访问并支持后续重邀重置权限 ✅
- [x] **E1-07**: 课程创建者可见侧边栏与班级子导航「助教管理」入口，协同教师无法越权邀请助教 ✅

---

### 五、遗留问题

- 无（进入 Phase 2：班级设置 + 课程规则）。
