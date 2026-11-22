# Phase 4 校验报告：课程资料中心

- **完成日期**：2026-11-17
- **覆盖范围**：Screen 50（`/teacher/courses/{cid}/files`，对标钉钉"知识库 / 群文件"）

---

### 一、实现清单

#### 后端与数据库
- [x] `services/api/app/modules/b/models.py`（修改）：新增 `BCourseFileFolder`（`b_course_file_folders`）、`BCourseMaterialItem`（`b_course_material_items`）、`BCourseMaterialVersion`（`b_course_material_versions`）。
- [x] `services/api/migrations/versions/0034_b_course_file_folders.py`（新增，147 行）：迁移 `0034`（`down_revision = "0033"`），创建目录、资料条目与不可变版本表及相关索引与约束，完全隔离 C 模块 `c_course_files` 表。
- [x] `services/api/app/modules/b/teacher_files_schemas.py`（新增，138 行）：目录树、面包含导航、资料条目、版本历史、批量操作与学生过滤视图 DTO。
- [x] `services/api/app/modules/b/teacher_files_service.py`（新增，719 行）：多级文件夹 CRUD（Python 侧统一处理根目录 `parent_id=NULL` 同名查重与防环校验）、Base64 字节解析与 SHA-256 校验上传、不可变版本追加（v1 → v2…）、可见范围控制（`all`/`grouped`/`staff`）、批量移动/修改可见性/删除，以及学生端可见范围过滤读取与安全下载（含 `403 MATERIAL_FORBIDDEN` 拦截）。
- [x] `services/api/app/modules/b/teacher_files_router.py`（新增，293 行）：挂载教师端 11 个管理/下载端点及学生端 `GET /api/v1/courses/{cid}/materials` 与 `.../download`。
- [x] `services/api/app/modules/b/router.py` & `teacher_classes_service.py`（修改）：挂载 `teacher_files_router`，并在 `delete_class` 补充空班资料/目录级联清理。
- [x] `services/api/tests/test_readiness.py`、`test_database.py`、`test_c_auth_migration_compatibility.py`（修改）：迁移头版本更新为 `0034`。
- [x] `services/api/tests/test_b_teacher_files.py`（新增，248 行）：覆盖助教 `manage_files` 权限守卫、目录树增改删与防环/查重、多版本上传下载、学生端未分组 vs 已分组 vs 仅教职/草稿过滤及批量移动。

#### 前端与国际化
- [x] `lib/api/teacher-files-client.ts`（新增，224 行）：封装文件夹与资料全量 API，提供浏览器 `File -> Base64` 编码辅助函数。
- [x] `features/teacher/TeacherFilesApiPage.tsx`（新增，804 行）：Screen 50 教师资料中心视图（左侧多级目录树与增改删、面包屑与搜索/可见性筛选、上传资料弹窗、批量操作工具栏、资料详情抽屉、多版本历史查看与新版发布、`useTeacherPermissions` `manageFiles` 权限门控）。
- [x] `features/b/screens.ts`、`features/route-dispatcher.tsx`、`lib/ux/navigation.ts`、`features/teacher/TeacherClassLayout.tsx`（修改）：注册 Screen 50 并接入「课程资料」子导航，保留 `bworkspace=mock, coursefiles=real` 时对既有 `CourseFilesApiPage` 的兼容。
- [x] `messages/{zh-Hans,zh-Hant,en}.json`、`lib/i18n/catalog/{en,zh-Hant}.ts`（修改）：新增 `nav.teacher.files` 与全套课程资料中心多语言词条。
- [x] `packages/domain/openapi.json`、`packages/domain/api.generated.ts`（自动重新生成）。

---

### 二、校验结果（V1–V11）

| # | 检查项 | 结果 | 备注 |
|---|---|---|---|
| V1 | `ruff check` | ✅ pass | `All checks passed!` |
| V2 | `ruff format --check` | ✅ pass | `336 files already formatted` |
| V3 | `pytest`（本阶段专项 + 全量） | ✅ pass | `test_b_teacher_files.py`: 1 passed；全量: **1029 passed, 363 skipped** |
| V4 | `npm run typecheck` | ✅ pass | exit 0 |
| V5 | `npm run lint` | ✅ pass | exit 0 |
| V6 | `npm run check:routes` | ✅ pass | 已核对 56 个设计页与路由 |
| V7 | `npm run check:ux` | ✅ pass | 22 项断言全部符合预期 |
| V8 | `npm run check:e2e` | ✅ pass | 40 项断言全部符合预期 |
| V9 | `npm run check:i18n` | ✅ pass | `zh-Hans / zh-Hant / en` 共 819 个键核对通过 |
| V10 | `npm run check:ui-catalog` | ✅ pass | `features/teacher/` 缺失词条数为 **0** |
| V11 | `npm run build` | ✅ pass | `next build` 生产构建成功（exit 0，沙箱外构建） |
| 额外 | Alembic 迁移链检查 | ✅ pass | `heads: ['0034']`, `top5: ['0034', '0033', '0032', '0031', '0030']` |

---

### 三、Verify-Diagnose-Fix 修复循环记录

- **循环 1（后端）**：
  - V1 检出 `b/models.py` 缺少 `TimestampMixin` 导入及 5 行超长行、`tests/test_b_teacher_files.py` 初稿引用了错误夹具属性 `world.course`（应为 `BWorld.course_id`）及 `assign_ta`。
  - 修复导入、格式化并使用 `CourseStaff` 与 `api.as_user(...)` 夹具接口后，专项 18 个测试与全量 **1029 passed**。
- **循环 2（前端）**：
  - V4 失败：`TeacherFilesApiPage.tsx:108` 调用了不存在的 `perms.can("manage_files")` → 修正为 `TeacherPermissionsState` 布尔属性 `perms.manageFiles`。
  - 复验 V4–V11 全部一次性通过。

---

### 四、效果验证（代码级 + 自动化测试 + 静态构建检查）

- [x] **E4-01**：多级目录树（`b_course_file_folders`）支持创建、根目录重名查重、重命名、防循环移动及删除上移保护，`test_b_teacher_files.py` 与 `TeacherFilesApiPage` 渲染均通过 ✅
- [x] **E4-02**：支持指定 `folder_id` 上传资料并计算 SHA-256 校验，在指定文件夹下精确检索展示 ✅
- [x] **E4-03**：支持设置 `all` / `grouped` / `staff` 可见范围，学生端 `/api/v1/courses/{cid}/materials` 对未分组学生拦截 `grouped`/`staff`，对已分组学生过滤 `staff` 与 `draft` ✅
- [x] **E4-04**：上传新版本递增 `latest_version_no` 并保留全部历史版本字节记录，支持指定 `?version_no=1..N` 下载 ✅

---

### 五、遗留问题

- 无（进入 Phase 5：课程公告）。
