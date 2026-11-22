# Phase 5 校验报告：课程公告系统

- **完成日期**：2026-11-17
- **覆盖范围**：Screen 60（`/teacher/courses/{cid}/announcements`，对标钉钉"群公告 + 已读/未读统计"）+ 学生端 `AnnouncementBanner`

---

### 一、实现清单

#### 后端与数据库
- [x] `services/api/app/modules/b/models.py`（修改）：新增 `BCourseAnnouncement`（`b_course_announcements`）与 `BAnnouncementRead`（`b_announcement_reads`，唯一约束 `uq_b_announcement_read`）。
- [x] `services/api/migrations/versions/0035_b_announcements.py`（新增，88 行）：迁移 `0035`（`down_revision = "0034"`），建立课程公告与已读回执表。
- [x] `services/api/app/modules/b/teacher_announcements_schemas.py`（新增，96 行）：公告列表、草稿/发布/置顶编辑、阅读统计名单、未读催读、学生端未读清单与已读签收 DTO。
- [x] `services/api/app/modules/b/teacher_announcements_service.py`（新增，476 行）：置顶优先排序、发布实时推送站内通知（`urgent` 自动前缀 `[紧急公告]`）、草稿发布、已读/未读学生名单对照、未读一键催读、`GET /me/announcements/unread` 学生聚合读取与幂等已读签收；受 `post_announcements` 权限守卫与结课只读拦截保护。
- [x] `services/api/app/modules/b/teacher_announcements_router.py`（新增，159 行）：挂载教师端 6 个公告端点及学生端 2 个读取/签收端点。
- [x] `services/api/app/modules/b/router.py` & `teacher_classes_service.py`（修改）：挂载 `teacher_announcements_router`，并在 `delete_class` 补充空班公告与回执级联清理。
- [x] `services/api/tests/test_readiness.py`、`test_database.py`、`test_c_auth_migration_compatibility.py`（修改）：迁移头版本更新为 `0035`。
- [x] `services/api/tests/test_b_teacher_announcements.py`（新增，176 行）：覆盖 `post_announcements` 助教授权、置顶优先排序、`urgent` 公告通知生成、学生未读查询与标为已读、已读/未读人数统计及 `[公告催读]` 通知发放。

#### 前端与国际化
- [x] `lib/api/teacher-announcements-client.ts`（新增，137 行）：封装教师端公告 CRUD / 统计 / 催读及学生端未读查询与已读签收客户端。
- [x] `features/teacher/TeacherAnnouncementsApiPage.tsx`（新增，431 行）：Screen 60 课程公告管理页（撰写/存草稿/立即发布弹窗、级别/置顶徽标、置顶切换、可展开已读/未读学生名单与「催读未读学生」按钮、`useTeacherPermissions` `postAnnouncements` 门控）。
- [x] `features/b/AnnouncementBanner.tsx`（新增，107 行）：学生端未读公告顶部横条，严格限定 `role === "student" && apiMode("bworkspace") === "real"` 时静默请求（`retry: false`，加载/空状态/异常均静默返回 `null`），点击展开正文并提交已读回执。
- [x] `features/b/CoursesApiPages.tsx` & `features/c/DailyApiPages.tsx`（修改）：分别在学生视角 `MyCoursesApiPage` 与 `HomeApiPage` 顶部挂载 `<AnnouncementBanner />`。
- [x] `lib/routes.ts`、`features/b/screens.ts`、`features/route-dispatcher.tsx`、`components/workspace-shell.tsx`、`lib/ux/navigation.ts`、`features/teacher/TeacherClassLayout.tsx`（修改）：注册 Screen 60，补齐 `bell` 图标与「课程公告」导航入口。
- [x] `messages/{zh-Hans,zh-Hant,en}.json`、`lib/i18n/catalog/{en,zh-Hant}.ts`（修改）：新增 `nav.teacher.announcements` 与公告系统全部 40 条多语言翻译。
- [x] `packages/domain/openapi.json`、`packages/domain/api.generated.ts`（自动重新生成）。

---

### 二、校验结果（V1–V11）

| # | 检查项 | 结果 | 备注 |
|---|---|---|---|
| V1 | `ruff check` | ✅ pass | `All checks passed!` |
| V2 | `ruff format --check` | ✅ pass | `341 files already formatted` |
| V3 | `pytest`（本阶段专项 + 全量） | ✅ pass | `test_b_teacher_announcements.py`: 1 passed；全量: **1031 passed, 363 skipped** |
| V4 | `npm run typecheck` | ✅ pass | exit 0 |
| V5 | `npm run lint` | ✅ pass | exit 0 |
| V6 | `npm run check:routes` | ✅ pass | 已核对 56 个设计页与路由 |
| V7 | `npm run check:ux` | ✅ pass | 22 项断言全部符合预期 |
| V8 | `npm run check:e2e` | ✅ pass | 40 项断言全部符合预期 |
| V9 | `npm run check:i18n` | ✅ pass | `zh-Hans / zh-Hant / en` 共 820 个键核对通过 |
| V10 | `npm run check:ui-catalog` | ✅ pass | `features/teacher/` 与 `AnnouncementBanner.tsx` 缺失词条数为 **0** |
| V11 | `npm run build` | ✅ pass | `next build` 生产构建成功（exit 0，沙箱外构建） |
| 额外 | Alembic 迁移链检查 | ✅ pass | `heads: ['0035']`, `top5: ['0035', '0034', '0033', '0032', '0031']` |

---

### 三、Verify-Diagnose-Fix 修复循环记录

- **循环 1（后端）**：
  - V3 失败：`mark_announcement_read` 查询 `CourseStaff.id` 抛出 `AttributeError`（`CourseStaff` 使用复合主键 `(course_id, user_id)`）。
  - 修正为 `select(CourseStaff.user_id)` 与 `select(CourseMember.user_id)` 后，复验 V1–V11 全部一次通过。

---

### 四、效果验证（代码级 + 自动化测试 + 静态构建检查）

- [x] **E5-01**：发布公告后立即返回并按发布时间倒序展示，标注作者及已读进度，`test_b_teacher_announcements.py` 验证通过 ✅
- [x] **E5-02**：`AnnouncementBanner` 挂载于 `/home` 与 `/courses`，学生端实时查询 `/api/v1/me/announcements/unread`，展开查看内容并调用 `POST .../read` 完成已读签收 ✅
- [x] **E5-03**：`GET .../reads` 返回已读/未读双列表，`POST .../remind` 向全部未读学生发放 `[公告催读]` 通知 ✅
- [x] **E5-04**：置顶公告在教师列表与学生未读队列均优先置顶排序 ✅
- [x] **E5-05**：`priority="urgent"` 公告自动投递带 `[紧急公告]` 标识的 `Notification` 记录，`test_b_teacher_announcements.py` 已查表确认 ✅

---

### 五、遗留问题

- 无（进入 Phase 6：数据报告中心）。
