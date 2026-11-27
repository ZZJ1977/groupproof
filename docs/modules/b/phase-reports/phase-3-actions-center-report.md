# Phase 3 校验报告：审批与操作中心

> **历史归档文档**：本文记录对应阶段的规划/验收快照，不代表当前最新状态；当前架构、实时交付状态与限制请以 [README.md](../../../../README.md) 与 [FRONTEND_STATUS.md](../../../../FRONTEND_STATUS.md) 为准。

- **完成日期**：2026-11-17
- **覆盖范围**：Screen 44（`/teacher/courses/{cid}/actions`，对标钉钉"待办审批中心"）

---

### 一、实现清单

#### 后端（Module B，不新增数据库表）
- [x] `services/api/app/modules/b/teacher_actions_schemas.py`（新增，92 行）：定义 `TeacherActionCategory`、`TeacherActionStatusFilter`、`TeacherActionPriority`、`TeacherActionButtonDTO`、`TeacherActionTargetDTO`、`TeacherActionItemDTO`、`TeacherActionSummaryDTO`、`TeacherActionPageDTO`、`HandleActionRequest`、`BatchHandleActionRequest`、`BatchHandleResultDTO`、`RemindActionRequest`、`RemindActionResultDTO` 等 DTO。
- [x] `services/api/app/modules/b/teacher_actions_service.py`（新增，790 行）：聚合查询当前教师可见范围下的待办与已处理项（入班申请 `CourseJoinRequest`、成员变动申请 `MemberChangeRequest`、项目/里程碑通知与逾期摘要 `milestone_briefs`、`ActionItem`），支持类型/状态/优先级多维筛选与分页；`handle_action` 分发至 `courses_service.decide_join`、成员变更审批及通知类签收标记，并按操作类型联动 Phase 1 `require_staff_permission` 校验；`batch_handle_actions` 批量处理并返回逐项成功/失败汇总；`remind_action` 向对应团队成员群发 `urgent` 站内通知并写审计记录。
- [x] `services/api/app/modules/b/teacher_actions_router.py`（新增，121 行）：挂载 4 个端点（`GET /actions`、`POST /actions/{action_id}/handle`、`POST /actions/batch`、`POST /actions/{action_id}/remind`）。
- [x] `services/api/app/modules/b/router.py`（修改）：挂载 `teacher_actions_router`。
- [x] `services/api/tests/test_b_teacher_actions.py`（新增，215 行）：覆盖入班申请聚合与批准/拒绝、成员变更跳转引导、逾期通知与 `remind` 群发 `urgent` 通知、批量 mark-read 及权限守卫。

#### 前端与国际化
- [x] `lib/api/teacher-actions-client.ts`（新增，107 行）：封装操作中心列表查询、单项处理、批量处理与催办 API 调用。
- [x] `features/teacher/ActionFilterPanel.tsx`（新增，120 行）：左侧待办分类（全部/入班审批/成员变动/进度逾期/通知提醒）、状态（待处理/已处理/全部）与优先级筛选面板，附各分类计数与「全部标记已读」触发器。
- [x] `features/teacher/ActionCard.tsx`（新增，89 行）：单条操作项卡片（复选框、优先级标识、目标对象/组信息、里程碑逾期与未完成任务摘要、快捷批准/拒绝/跳转处理/催办操作区）。
- [x] `features/teacher/TeacherActionsApiPage.tsx`（新增，254 行）：Screen 44 操作中心主视图，集成批量勾选与处理工具栏、筛选面板、理由确认弹窗、分页控制与实时待办数刷新回调。
- [x] `features/route-dispatcher.tsx`（修改）：为 `screen === 44` 接入 `TeacherActionsApiPage`。
- [x] `features/teacher/TeacherClassLayout.tsx`（修改）：接入 60 秒轮询获取待办数量，在班级子导航「操作中心」标签旁渲染红色数字徽标。
- [x] `lib/i18n/catalog/en.ts`、`lib/i18n/catalog/zh-Hant.ts`（修改）：补全操作中心词条，保持全量多语言翻译键一致。
- [x] `packages/domain/openapi.json`、`packages/domain/api.generated.ts`（自动重新生成）：同步操作中心 OpenAPI 契约与 TypeScript 类型定义。

---

### 二、校验结果（V1–V11）

| # | 检查项 | 结果 | 备注 |
|---|---|---|---|
| V1 | `ruff check` | ✅ pass | `All checks passed!` |
| V2 | `ruff format --check` | ✅ pass | `331 files already formatted` |
| V3 | `pytest`（本阶段专项 + 全量） | ✅ pass | `test_b_teacher_actions.py`: 1 passed；全量: **1027 passed, 363 skipped** |
| V4 | `npm run typecheck` | ✅ pass | exit 0 |
| V5 | `npm run lint` | ✅ pass | exit 0 |
| V6 | `npm run check:routes` | ✅ pass | 已核对 56 个设计页与路由 |
| V7 | `npm run check:ux` | ✅ pass | 22 项断言全部符合预期 |
| V8 | `npm run check:e2e` | ✅ pass | 40 项断言全部符合预期 |
| V9 | `npm run check:i18n` | ✅ pass | `zh-Hans / zh-Hant / en` 共 818 个键核对通过 |
| V10 | `npm run check:ui-catalog` | ✅ pass | `features/teacher/` 缺失词条数为 **0**（全仓库存量 257 处来自既有 C 模块页面） |
| V11 | `npm run build` | ✅ pass | `next build` 生产构建成功（exit 0，沙箱外构建） |

---

### 三、Verify-Diagnose-Fix 修复循环记录

- **循环 1**：
  - V1 / V2 校验发现 `services/api/app/modules/b/teacher_actions_service.py` 存在 1 处未使用变量及 2 行超长格式化问题。
  - 修复后复验 V1–V11 全部一次性通过，无回归。

---

### 四、效果验证（代码级 + 自动化测试 + 静态构建检查）

- [x] **E3-01**：Screen 44 路由解析与 `TeacherActionsApiPage` + `ActionFilterPanel` 接入 `TeacherClassLayout` 渲染就绪，`next build` 与 `check:routes`/`check:ux` 通过 ✅
- [x] **E3-02**：入班审批在 `teacher_actions_service.py` 联动 `courses_service.decide_join` 并更新对应 `ActionItem` 状态，单元测试验证通过 ✅
- [x] **E3-03**：成员变动操作项输出指向 Screen 48（`/teacher/courses/{cid}/member-changes`）的 `href` 与交接摘要，`ActionCard` 正确渲染跳转按钮 ✅
- [x] **E3-04**：里程碑逾期汇总复用 `milestones_service.milestone_briefs` 计算逾期天数、进度与未完成任务数 ✅
- [x] **E3-05**：筛选切换触发 `TeacherActionsApiPage` 重新拉取过滤分页；「全部标记已读」调用 `POST /actions/batch` 一键处理通知类待办，pytest 验证通过 ✅
- [x] **E3-06**：`TeacherClassLayout.tsx` 轮询待办总数并在「操作中心」标签渲染红色数量徽标 ✅
- [x] **E3-07**：`POST /actions/{action_id}/remind` 向组内成员发送 `urgent` 级别通知并返回 `notified_count`，pytest 验证通过 ✅

> 注：受当前本地运行环境限制，未直接连接运行中 Docker 容器执行人工浏览器点击巡检；全部效果已通过后端 pytest 端到端链路测试、前端静态门禁（V4–V10）与 Next.js 生产构建（V11）验证。

---

### 五、遗留问题

- 无（进入 Phase 4：课程资料中心）。
