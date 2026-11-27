# Phase 6 校验报告：数据报告中心

> **历史归档文档**：本文记录对应阶段的规划/验收快照，不代表当前最新状态；当前架构、实时交付状态与限制请以 [README.md](../../../../README.md) 与 [FRONTEND_STATUS.md](../../../../FRONTEND_STATUS.md) 为准。

- **完成日期**：2026-11-17
- **覆盖范围**：Screen 45（`/teacher/courses/{cid}/reports`，对标钉钉"数据看板 + 导出报表"）

---

### 一、实现清单

#### 后端（Module B，不新增数据库表）
- [x] `services/api/app/modules/b/teacher_reports_schemas.py`（新增，161 行）：定义总览、进度、里程碑矩阵、风险明细、学生活跃度、贡献度汇总及导出 DTO。
- [x] `services/api/app/modules/b/teacher_reports_service.py`（新增，654 行）：跨 `b`、`d`、`a` 只读表聚合计算（复用 `milestones_service.milestone_briefs`、`d.models.Risk` / `ContributionSnapshot` / `ContributionItem`、`a.models.GithubActivity` / `FeishuMessage`、`core.Task` / `TaskAssignee` / `ProgressEvent`），并支持 UTF-8 BOM CSV、Markdown 与 JSON 报表导出（受 `export_reports` 权限守卫）。
- [x] `services/api/app/modules/b/teacher_reports_router.py`（新增，90 行）：挂载 `overview`、`progress`、`milestones`、`risks`、`activity`、`contribution`、`export` 与 `export/download` 共 8 个端点。
- [x] `services/api/app/modules/b/router.py`（修改）：挂载 `teacher_reports_router`。
- [x] `services/api/tests/test_b_teacher_reports.py`（新增，281 行）：覆盖真实造数场景（`Task`、`Milestone`、D 模块 `Risk`、`GithubActivity`、贡献度快照），校验 6 项统计查询、低活跃标记、`export_reports` 助教权限拦截及 BOM CSV / Markdown 下载。

#### 前端与国际化
- [x] `lib/api/teacher-reports-client.ts`（新增，174 行）：封装报告中心全部只读查询与导出 API 客户端。
- [x] `features/teacher/charts/ProgressChart.tsx`（新增，72 行）：纯 SVG + Tailwind 分色进度条形图（零外部图表库依赖）。
- [x] `features/teacher/charts/MilestoneTimeline.tsx`（新增，62 行）：小组 × 里程碑完成态与逾期时间线矩阵组件。
- [x] `features/teacher/charts/RiskMatrix.tsx`（新增，59 行）：高/中风险预警卡片与成因拆解列表。
- [x] `features/teacher/charts/ActivityRanking.tsx`（新增，55 行）：学生 GitHub/任务/进度活跃度排行榜（含偏低预警徽标）。
- [x] `features/teacher/TeacherReportsApiPage.tsx`（新增，263 行）：Screen 45 数据报告中心主视图（4 项顶部概览指标卡、四大分析看板、贡献度快照总览及 CSV/Markdown 离线下载按钮，`useTeacherPermissions` `exportReports` 门控）。
- [x] `features/b/screens.ts`、`features/route-dispatcher.tsx`、`features/teacher/TeacherClassLayout.tsx`（修改）：注册 Screen 45 并接入「班级报告」子导航标签。
- [x] `lib/i18n/catalog/{en,zh-Hant}.ts`（修改）：补全报告中心 45 条多语言词条。
- [x] `packages/domain/openapi.json`、`packages/domain/api.generated.ts`（自动重新生成）。

---

### 二、校验结果（V1–V11）

| # | 检查项 | 结果 | 备注 |
|---|---|---|---|
| V1 | `ruff check` | ✅ pass | `All checks passed!` |
| V2 | `ruff format --check` | ✅ pass | `345 files already formatted` |
| V3 | `pytest`（本阶段专项 + 全量） | ✅ pass | `test_b_teacher_reports.py`: 1 passed；全量: **1032 passed, 363 skipped** |
| V4 | `npm run typecheck` | ✅ pass | exit 0 |
| V5 | `npm run lint` | ✅ pass | exit 0 |
| V6 | `npm run check:routes` | ✅ pass | 已核对 56 个设计页与路由 |
| V7 | `npm run check:ux` | ✅ pass | 22 项断言全部符合预期 |
| V8 | `npm run check:e2e` | ✅ pass | 40 项断言全部符合预期 |
| V9 | `npm run check:i18n` | ✅ pass | `zh-Hans / zh-Hant / en` 共 820 个键核对通过 |
| V10 | `npm run check:ui-catalog` | ✅ pass | `features/teacher/` 与 `AnnouncementBanner.tsx` 缺失词条数为 **0** |
| V11 | `npm run build` | ✅ pass | `next build` 生产构建成功（exit 0，沙箱外构建） |

---

### 三、Verify-Diagnose-Fix 修复循环记录

- **循环 1（后端格式）**：
  - V1 检出 2 行超长注释/字符串换行，wrap 后 V1–V11 全量一次性通过。

---

### 四、效果验证（代码级 + 自动化测试 + 静态构建检查）

- [x] **E6-01**：`/reports/overview` 返回学生数、队伍数、已立项数、整体进度与风险计数，顶部 4 卡展示完整 ✅
- [x] **E6-02**：`ProgressChart` 以纯 SVG 分色（绿/黄/红/灰）展示各组进度百分比与任务完成数 ✅
- [x] **E6-03**：`MilestoneTimeline` 与 `/reports/milestones` 返回小组 × 里程碑完成态与逾期状态矩阵 ✅
- [x] **E6-04**：`RiskMatrix` 聚合 D 模块 `Risk` 记录与逾期里程碑，准确输出高/中风险原因列表 ✅
- [x] **E6-05**：`ActivityRanking` 按 GitHub 提交、进度事件与完成任务降序排行，并为低活跃学生打上「偏低」预警标记 ✅
- [x] **E6-06**：受 `export_reports` 权限控制，点击按钮可下载 UTF-8 BOM CSV（Excel 可直接打开）或 Markdown 教学报告 ✅

---

### 五、遗留问题

- 无（进入 Phase 7：申诉与争议处理）。
