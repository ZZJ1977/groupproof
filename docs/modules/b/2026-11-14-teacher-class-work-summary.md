# 阶段性工作总结：上游同步、目录整理与教师端班级/组队广场开发

> **历史归档文档**：本文记录对应阶段的规划/验收快照，不代表当前最新状态；当前架构、实时交付状态与限制请以 [README.md](../../../README.md) 与 [FRONTEND_STATUS.md](../../../FRONTEND_STATUS.md) 为准。

- 总结日期：2026-11-14
- 仓库路径：`/Users/motasy_delay/GroupProof-team/groupproof`
- 当前分支：`B_task`（基于 `7205fed`）
- 关联计划：[`docs/modules/b/2026-11-14-teacher-class-plan.md`](./2026-11-14-teacher-class-plan.md)
- Git 状态：**全部改动仅保留在本地工作区**（含已暂存的 `origin/develop` (`15f713f`) `--no-commit` 合并），**未执行 `git commit`、`git push`、`git merge --continue` 或任何分支改写操作**，待用户确认后再提交与合并。

---

## 1. 上游进度同步与冲突处理

1. 将远程仓库 `origin/develop`（`15f713f`）的最新开发进度通过 `git merge --no-commit` 同步至本地工作区。
2. 解决数据库迁移编号冲突：A 模块新增 `0019_a_*`–`0024_a_*` 后，将 B 模块原有迁移文件 `0019_b_*.py`–`0025_b_*.py` 顺延重编号为：
   - `services/api/migrations/versions/0025_b_course_joins.py`
   - `services/api/migrations/versions/0026_b_groups.py`
   - `services/api/migrations/versions/0027_b_projects.py`
   - `services/api/migrations/versions/0028_b_requirements_analysis.py`
   - `services/api/migrations/versions/0029_b_requirement_versions.py`
   - `services/api/migrations/versions/0030_b_planning.py`
   - `services/api/migrations/versions/0031_b_milestones_membership.py`
3. 合并及本地工作结果保留于未提交工作区中，未提交至分支历史。

---

## 2. 项目目录结构与文档整理

按“架构文档 + 按模块（A/B/C）归档”的方式重新组织文档，并清理历史冗余文件与废弃目录：

1. **文档归档目录（`docs/` 现存 24 份文件）**：
   - `docs/architecture/`：`DEPLOYMENT.md`、`DEVELOPMENT.md`、`ERD.md`、`FRONTEND_IMPLEMENTATION_PLAN.md`、`TECHNICAL_PLAN.md`
   - `docs/modules/a/`：`A_SHARED_SERVICES.md`
   - `docs/modules/b/`：`2026-11-05-b-module-staged-development-plan.md`、`2026-11-14-teacher-class-plan.md`、`B_INTERFACES.md`
   - `docs/modules/c/`：`2026-11-09-C-weekly.md` 及 `C_ACTIVITY_RECORDS.md`、`C_ADMIN_DIRECTORY.md`、`C_COURSE_FILES.md`、`C_DAILY_READS.md`、`C_DELIVERY.md`、`C_DISCUSSIONS.md`、`C_EVIDENCE.md`、`C_GOVERNANCE.md`、`C_IDENTITY_ADMIN.md`、`C_INBOX.md`、`C_PROJECT_FILES.md`、`C_REAL_PAGES.md`、`C_REMAINING_WORK.md`、`C_TASK_EXECUTION.md`
2. **清理无关紧要及废弃文件**：
   - 移除根目录冗余说明文件 `AGENTS.md`、`FRONTEND_IMPLEMENTATION_PLAN.md`、`FRONTEND_STATUS.md`；
   - 移除 `docs/` 根目录旧文档以及 `docs/development-stages/`、`docs/plans/`、`docs/reviews/`、`docs/erd-preview/`、`docs/design/screenshots/`、`docs/weekly/` 下的历史阶段报告与截图；
   - 移除遗留目录文件 `server/`（旧 FastAPI 服务代码、旧迁移与测试）、`apps/web/README.md`、`infra/README.md`；
   - 同步更新路由核对脚本 `scripts/check-routes.mjs`。

---

## 3. 教师端深度开发实现（对照计划 §3–§6 & §8）

严格遵循计划 §0.2 的硬性约束：
- **不新增数据库迁移**，全部复用现有数据表；
- **不修改 C 模块代码**，保留既有 32 位 `secrets.token_urlsafe(24)` 邀请码格式与加入校验；
- **不新增 npm / pip 依赖**，拖拽基于浏览器原生 HTML5 Drag & Drop；
- **保留演示版页面** `features/governance/TeacherViews.tsx`。

### 3.1 后端接口与业务逻辑（B 模块）

| 文件 | 变更 | 核心内容 |
| --- | --- | --- |
| `services/api/app/modules/b/teacher_classes_schemas.py` | 新增 | 请求 Schema（`CreateClass`、`RotateInvite`、`RemoveStudent`、`TeacherCreateGroup`、`Assign`、`SetLeader`）与响应 DTO（`TeacherClassPageDTO`、`ClassDetailDTO`、`RosterDTO`、`GroupProgressDTO`、`PlazaDTO`、`AssignResultDTO`、`TeacherGroupDetailDTO` 等） |
| `services/api/app/modules/b/teacher_classes_service.py` | 新增 | 实现班级管理、邀请码、侧边栏花名册、组队广场分配、队长指定与队伍里程碑进度汇总全部业务逻辑 |
| `services/api/app/modules/b/teacher_classes_router.py` | 新增 | 定义 11 个 `/teacher/classes...` HTTP 路由，接入权限、幂等与 `envelope` 返回规范 |
| `services/api/app/modules/b/router.py` | 修改 | 在 `/api/v1` 前缀下挂载 `teacher_classes_router` |
| `services/api/app/modules/b/milestones_service.py` | 修改 | 抽出公开函数 `milestone_briefs(session, project_id)`，`list_milestones` 改为委托调用，行为保持不变 |

**已挂载的 11 个 API 端点（均在 `/api/v1` 下）**：
1. `GET /teacher/classes`（`list_classes`）：按教师/助教范围列出所授/协作班级，支持状态标签筛选与关键词查询。
2. `POST /teacher/classes`（`create_class`，201）：校验教师身份（`require_teacher`）与项目截止时间，编号留空时自动生成 `CLS-XXXXXX`；直接生成 `status="active"` 课程，写入教师 `CourseStaff`、调用 `reserve_code`、记录 `CourseLifecycleDecision(action="create")`、生成 32 位 `CourseInvite`、设置 `BCourseJoinPolicy` 并记录审计 `class.created`。
3. `GET /teacher/classes/{course_id}`（`get_class`）：返回班级详情、活跃邀请码、`join_url`、统计计数与 `can_manage`。
4. `POST /teacher/classes/{course_id}/invite-code/rotate`（`rotate_invite`）：校验课程版本乐观锁后重置邀请码。
5. `GET /teacher/classes/{course_id}/roster`（`roster`）：返回班级学生列表（全部/已组队/未组队计数、待审批入班数 `pending_join_count`、所在队伍及是否已立项标识）。
6. `POST /teacher/classes/{course_id}/students/{student_id}/remove`（`remove_student`）：仅允许移出未组队学生（仍在队伍中返回 `409 STUDENT_IN_GROUP`），标记 `left_at` 并发送站内通知与审计 `class.student_removed`。
7. `GET /teacher/classes/{course_id}/plaza`（`plaza`）：返回组队广场所需的未组队学生池与各队伍概览（含成员、容量、锁定状态及里程碑进度）。
8. `POST /teacher/classes/{course_id}/groups`（`create_group`，201）：教师在组队广场直接创建空队伍。
9. `POST /teacher/classes/{course_id}/assignments`（`assign`）：支持「未组队池 ↔ 队伍」与「队伍 ↔ 队伍」成员调整，分配时传入 `check_deadline=False` 以越过学生组队截止时间限制；执行来源/目标组乐观锁校验 `require_version` 及 `roster_frozen` 检查；若来源队伍存在未归档项目则返回 `409 GROUP_HAS_PROJECT` 及 `details.member_changes_href`（引导走页面 48 成员变动流程）；移出未立项队伍队长时同步清空 `leader_id`；拖入已立项队伍时同步写入 `project_members`。
10. `POST /teacher/classes/{course_id}/groups/{group_id}/leader`（`set_leader`）：校验队内成员资格（非成员返回 `422 NOT_GROUP_MEMBER`）、乐观锁与未冻结状态后指定队长，发送审计与通知。
11. `GET /teacher/classes/{course_id}/groups/{group_id}`（`group_detail`）：返回队伍详情、成员列表（含角色与 `open_task_count`）、`milestones` 明细（来自 `milestone_briefs`）与 `member_changes_href`。

**进度统计规则（`_group_progress`）**：
- 无活跃项目：`state="no_project"`，`overall_percent=null`；
- 有项目但无里程碑：`state="no_milestones"`，`overall_percent=null`；
- 有里程碑：`state="tracking"`，计算 `milestones_total`、`milestones_completed`、关联任务的里程碑 `progress_percent` 均值四舍五入为 `overall_percent`、下一个未完成里程碑 `next_milestone`、`overdue_count` 及最高风险等级 `risk_level`。

### 3.2 OpenAPI 契约与生成类型

| 文件 | 变更 | 说明 |
| --- | --- | --- |
| `services/api/scripts/export_openapi.py` | 修改 | 添加 `sys.path.insert` 支持从仓库根目录直接执行导出脚本 |
| `packages/domain/openapi.json` | 重新生成 | 导出包含 11 个教师班级与组队广场接口的最新 OpenAPI 快照 |
| `packages/domain/api.generated.ts` | 重新生成 | 通过 `node groupproof/scripts/generate-api-client.mjs` 重新生成 TypeScript 类型定义 |

### 3.3 前端页面、组件、路由与多语言

| 文件 | 变更 | 说明 |
| --- | --- | --- |
| `lib/api/teacher-client.ts` | 新增 | 封装 `teacherKeys` 与 `teacherClassesApi`（`list`、`create`、`detail`、`rotateInvite`、`roster`、`removeStudent`、`plaza`、`createGroup`、`assign`、`setLeader`、`groupDetail`） |
| `features/b/ui.ts` | 修改 | 新增并统一导出 `card`、`dateTime`、`errorText` |
| `features/teacher/TeacherClassesApiPage.tsx` | 新增 | 页面 57（`/teacher/courses`）：班级列表与创建班级表单，建班后即时弹出包含 `InviteCodeCard` 的横幅 |
| `features/teacher/TeacherClassHomeApiPage.tsx` | 新增 | 页面 41（`/teacher/courses/{cid}`）：班级基本信息、邀请码展示/重置、队伍进度概览及进入组队广场入口 |
| `features/teacher/TeamPlazaApiPage.tsx` | 新增 | 页面 42（`/teacher/courses/{cid}/groups`）：学生组队广场，支持创建空队伍、未组队池与队伍间拖拽分配、`VERSION_CONFLICT` 自动刷新重试、`GROUP_HAS_PROJECT` 提示并附成员变动页跳转链接 |
| `features/teacher/TeacherGroupDetailApiPage.tsx` | 新增 | 页面 43（`/teacher/courses/{cid}/groups/{gid}`）：组队详情页，展示队员详情表、指定队长、里程碑进度条与各里程碑明细 |
| `features/teacher/TeacherClassLayout.tsx` | 新增 | 教师班级共用外壳：顶部子导航（我的班级 / 班级首页 / 学生组队广场 / 成员变动）与右侧花名册侧边栏 |
| `features/teacher/ClassRosterSidebar.tsx` | 新增 | 班级学生侧边栏：每 30 秒自动轮询并在窗口聚焦时刷新，集成邀请码卡片、待审批入班提示、关键词搜索、全部/已组队/未组队筛选及学生详情/移出班级抽屉 |
| `features/teacher/InviteCodeCard.tsx` | 新增 | 邀请码展示、复制邀请码、复制加入链接与重置邀请码卡片 |
| `features/teacher/StudentEntity.tsx` | 新增 | 可拖拽学生实体卡片（`application/x-gp-student`），提供键盘可达的“分配到…”下拉选择器、队长徽章与已立项锁定态显示 |
| `features/teacher/StudentProfileDrawer.tsx` | 新增 | 学生资料抽屉与移出班级二次确认流程 |
| `features/teacher/TeamCard.tsx` | 新增 | 队伍拖放目标卡片，支持满员/冻结/不可拖出校验、队员重分配及指定队长 |
| `features/teacher/GroupProgressBar.tsx` | 新增 | 三态进度组件：渲染 `no_project`（尚未立项）、`no_milestones`（暂无里程碑）与 `tracking`（已完成数/总数、进度条、下一里程碑、逾期与风险） |
| `lib/routes.ts` | 修改 | 新增 `"/teacher/courses": 57`、`teacherScreens = [41..50, 57]`、`isTeacherScreen` |
| `features/b/screens.ts` | 修改 | 将 `41, 42, 43, 57` 纳入 `bScreens` |
| `features/route-dispatcher.tsx` | 修改 | 引入 `isTeacherScreen` 区分外壳，在 `apiMode("bworkspace") === "real"` 时动态挂载页面 `57, 41, 42, 43` |
| `components/workspace-shell.tsx` | 修改 | 在教师左侧导航前插“我的班级”（`/teacher/courses`），并保持现有导航断言兼容 |
| `lib/i18n/catalog/en.ts`、`lib/i18n/catalog/zh-Hant.ts` | 修改 | 补充教师端新增页面与组件的所有简体中文源文案对应的英文与繁体中文翻译 |

### 3.4 接口文档更新

- 修改 `docs/modules/b/B_INTERFACES.md`，文末新增 `## 8. 教师班级与组队广场（需要 C、D 知悉）`，说明写表边界（`courses`、`c_course_invites`、`c_course_code_registry`、`c_course_lifecycle_decisions`）、邀请码格式不变、老师分配规则（`GROUP_HAS_PROJECT`、忽略组队截止时间、名单冻结限制）以及复用 `milestone_briefs` 算法。

### 3.5 自动化测试补强

- 新增 `services/api/tests/test_b_teacher_classes_postgres.py`（5 个测试函数覆盖计划 §7.1 中的 `T1`–`T16`）：
  - `test_t1_t2_t3_t4_teacher_creates_class_student_joins_and_invite_rotates`
  - `test_t5_permissions_and_ta_read_only`
  - `test_t6_t7_t8_t9_t10_t12_t13_t14_plaza_assign_remove_and_leader`
  - `test_t11_concurrent_assign_to_last_seat_allows_only_one`（强依赖 PostgreSQL 行锁并发验证）
  - `test_t15_t16_milestone_progress_states_and_consistency`
- 在本地未启动 PostgreSQL 且未设置 `B_TEST_DATABASE_URL` 的情况下，`b_engine` 提供 SQLite 内存数据库回退（模拟 `gen_random_uuid` / `to_regclass` 与 UTC 时区）以验证 `T1`–`T10`、`T12`–`T16` 逻辑；并发抢占测试 `test_t11` 在无 PostgreSQL 时显式跳过。

---

## 4. 验证与检查结果汇总（均在最后一次代码/翻译修改后实测）

| 检查项 | 执行命令 | 实测结果 | 备注 / 范围说明 |
| --- | --- | --- | --- |
| 后端 Ruff lint | `groupproof/services/api/.venv/bin/ruff check groupproof/services/api` | **通过**（`All checks passed!`） | 最后一次 `--fix` 后复核 |
| 后端 Ruff format | `groupproof/services/api/.venv/bin/ruff format --check groupproof/services/api` | **通过**（`316 files already formatted`） | 全量 Python 代码 |
| 后端定向 pytest | `pytest ... test_b_teacher_classes_postgres.py test_openapi_snapshot.py test_b_foundation.py test_readiness.py` | **`21 passed, 1 skipped`**（1.48s） | 因无 `B_TEST_DATABASE_URL`，`test_b_teacher_classes_postgres.py` 为 4 项在 SQLite 内存回退下通过 + `test_t11` 跳过 |
| 后端全量 pytest | `pytest -c groupproof/services/api/pyproject.toml groupproof/services/api/tests` | **`1019 passed, 363 skipped`**（64.27s，共 1382 项） | 未配置本地 PostgreSQL 时 `*_postgres.py` 及依赖外部环境的用例按条件跳过 |
| 前端 TypeScript 类型检查 | `npm --prefix groupproof run typecheck` | **通过**（退出码 0） | `tsc --noEmit` |
| 前端 ESLint 检查 | `npm --prefix groupproof run lint` | **通过**（退出码 0） | `eslint .` |
| 前端生产构建 | `npm --prefix groupproof run build` | **通过**（退出码 0） | `Compiled successfully in 3.7s`，`5/5` 静态页 |
| 路由与设计页核对 | `npm --prefix groupproof run check:routes` | **通过**（退出码 0） | `已核对 56 个设计页与路由。` |
| 前端 UX 定向回归 | `npm --prefix groupproof run check:ux` | **通过**（退出码 0） | `UX 定向复核回归通过：22 项断言全部符合预期。` |
| 前端功能 E2E 走查 | `npm --prefix groupproof run check:e2e` | **通过**（退出码 0） | `功能验收端到端走查通过：40 项断言全部符合预期。` |
| 前端多语言词条校验 | `npm --prefix groupproof run check:ui-catalog` | **退出码 1（257 处）** | 257 处均位于既有 `features/c/`、`features/d/`、`features/feishu-binding/`、`features/github-binding/`、`features/project-support/`、`lib/api/c-*.ts`；**本次新增/修改的 `features/teacher/`、`features/b/`、`components/` 等文件中 0 处缺失** |

---

## 5. 与计划的差异及待办事项（提交与合并前建议）

1. **PostgreSQL 真实数据库验证尚未运行**：当前本地环境未运行 PostgreSQL（`127.0.0.1:5432` 未启动），因此 `test_t11_concurrent_assign_to_last_seat_allows_only_one` 及所有依赖真实 PG 的 `test_b_*_postgres.py`（含 `test_b_milestones_postgres.py` 等 `T16` 目标文件）在测试时均被跳过；`test_b_teacher_classes_postgres.py` 中其余 4 个测试函数目前是通过 SQLite 内存回退跑通。**建议在启动 PostgreSQL 并配置 `B_TEST_DATABASE_URL` 后补充跑通全套 `_postgres.py` 用例。**
2. **真实前后端联调手工检查待执行**：计划 §7.3 中的 `bworkspace=real` 本地联调交互走查（跨账号学生入班、30 秒侧边栏刷新、真实浏览器拖拽手感、三语界面切换）需在启动本地后端服务与数据库后执行。
3. **Git 提交与合并保留给用户**：当前所有同步合并（`origin/develop`）与教师端开发改动均留在 `B_task` 工作区，待用户验收后执行最终提交与合并。
