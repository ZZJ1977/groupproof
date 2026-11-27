# Phase 2 校验报告：班级设置 + 课程规则

> **历史归档文档**：本文记录对应阶段的规划/验收快照，不代表当前最新状态；当前架构、实时交付状态与限制请以 [README.md](../../../../README.md) 与 [FRONTEND_STATUS.md](../../../../FRONTEND_STATUS.md) 为准。

- **完成日期**：2026-11-17
- **覆盖范围**：Screen 46（`/teacher/courses/{cid}/settings`，对标钉钉"组织设置"）+ Screen 47（`/teacher/courses/{cid}/rules`，对标钉钉"审批模板管理"）

---

### 一、实现清单

#### 后端与数据库
- [x] `services/api/app/db/models/core.py`（修改）：`Course` 新增 `description`（`Text`）与 `archived_at`（`DateTime(timezone=True)`）
- [x] `services/api/app/modules/b/models.py`（修改）：新增 `BCourseRuleVersion`（`b_course_rule_versions`）
- [x] `services/api/migrations/versions/0033_b_course_rules.py`（新增，57 行）：迁移 `0033`（`down_revision = "0032"`）
- [x] `services/api/app/modules/b/teacher_classes_schemas.py`、`teacher_classes_service.py`、`teacher_classes_router.py`（修改）：新增 `get_settings`、`update_settings`、`end_class`、`archive_class`、`reopen_class`、`delete_class` 共 6 个设置与生命周期端点，并在 `list_classes?tab=active` 排除已归档班级
- [x] `services/api/app/modules/b/teacher_rules_schemas.py`（新增，98 行）：`CourseRulesDTO`、`RuleMilestoneItem`、`ContributionWeights`（和为 100% 校验）、`RuleVersionDTO`、`CourseRulesOverviewDTO`
- [x] `services/api/app/modules/b/teacher_rules_service.py`（新增，345 行）：规则概览、历史版本查看、草稿保存、规则发布（不可变版本递增、同步未来立项 `BCourseProjectTemplate`、不改动已有项目、通知全班并写审计）
- [x] `services/api/app/modules/b/teacher_rules_router.py`（新增，82 行）：挂载 5 个规则与模板端点
- [x] `services/api/app/modules/b/router.py`（修改）：挂载 `teacher_rules_router`
- [x] `services/api/tests/test_readiness.py`、`test_database.py`、`test_c_auth_migration_compatibility.py`（修改）：迁移头版本更新为 `0033`
- [x] `services/api/tests/test_b_teacher_rules.py`（新增，250 行）：覆盖设置更新、加入模式切换、结课只读拦截（`409 COURSE_NOT_ACTIVE`）、归档/重开、空班删除守卫、规则草稿与版本发布、`BCourseProjectTemplate` 同步及已有项目隔离

#### 前端与国际化
- [x] `lib/api/teacher-client.ts`（修改）：新增 `settings`、`updateSettings`、`endClass`、`archiveClass`、`reopenClass`、`deleteClass`
- [x] `lib/api/teacher-rules-client.ts`（新增，97 行）：规则概览/草稿/发布/版本快照客户端
- [x] `features/teacher/MilestoneTemplateEditor.tsx`（新增，177 行）：可增删调序的阶段里程碑模板编辑器
- [x] `features/teacher/TeacherSettingsApiPage.tsx`（新增，529 行）：Screen 46（基础信息、加入策略与邀请码、结课/删除输入班级名二次确认弹窗、归档/重开操作）
- [x] `features/teacher/TeacherRulesApiPage.tsx`（新增，593 行）：Screen 47（组队规则、项目与里程碑模板、交付物清单、评分权重和为 100% 校验、发布摘要确认与版本历史快照弹窗）
- [x] `features/b/screens.ts`、`features/route-dispatcher.tsx`、`lib/ux/navigation.ts`、`features/teacher/TeacherClassLayout.tsx`（修改）：注册 Screen 46/47 并接入「课程规则」「班级设置」导航入口
- [x] `messages/{zh-Hans,zh-Hant,en}.json`、`lib/i18n/catalog/{en,zh-Hant}.ts`（修改）：新增 96 条多语言翻译与导航键
- [x] `packages/domain/openapi.json`、`packages/domain/api.generated.ts`（自动重新生成）

---

### 二、校验结果（V1–V11）

| # | 检查项 | 结果 | 备注 |
|---|---|---|---|
| V1 | `ruff check` | ✅ pass | `All checks passed!` |
| V2 | `ruff format --check` | ✅ pass | `327 files already formatted` |
| V3 | `pytest`（本阶段专项 + 全量） | ✅ pass | `test_b_teacher_rules.py`: 2 passed；全量: **1026 passed, 363 skipped** |
| V4 | `npm run typecheck` | ✅ pass | exit 0 |
| V5 | `npm run lint` | ✅ pass | exit 0 |
| V6 | `npm run check:routes` | ✅ pass | 已核对 56 个设计页与路由 |
| V7 | `npm run check:ux` | ✅ pass | 22 项断言全部符合预期 |
| V8 | `npm run check:e2e` | ✅ pass | 40 项断言全部符合预期 |
| V9 | `npm run check:i18n` | ✅ pass | `zh-Hans / zh-Hant / en` 共 818 个键核对通过 |
| V10 | `npm run check:ui-catalog` | ✅ pass | Phase 2 新增/修改文件缺失数为 **0** |
| V11 | `npm run build` | ✅ pass | `next build` 生产构建成功 |
| 额外 | Alembic 迁移链检查 | ✅ pass | `heads: ['0033']`, `top4: ['0033', '0032', '0031', '0030']` |

---

### 三、Verify-Diagnose-Fix 修复循环记录

- **循环 1**：
  - V4 失败：`TeacherSettingsApiPage.tsx:7` 从 `@/features/b/ui` 导入了未导出的 `danger` 样式 → 在组件内定义本地红色危险按钮样式 `danger`。
  - 复验 V4、V5、V10、V3、V11 全部一次性通过。

---

### 四、效果验证

- [x] **E2-01**: `/teacher/courses/{cid}/settings` 基础信息与截至时间修改保存通过 ✅
- [x] **E2-02**: 加入方式（`direct` / `approval`）切换立即生效 ✅
- [x] **E2-03**: 结束课程需输入班级名称二次确认，确认后 `status="ended"` 并显示只读横幅 ✅
- [x] **E2-04**: 结课后写操作返回 `409 COURSE_NOT_ACTIVE`，重开/归档/空班删除守卫工作正常 ✅
- [x] **E2-05**: `/teacher/courses/{cid}/rules` 正常展示组队、项目模板、评分权重与版本历史 ✅
- [x] **E2-06**: 发布规则自动递增版本号（v1 → v2）并将旧版标为 `archived` ✅
- [x] **E2-07**: `MilestoneTemplateEditor` 支持添加/删除/上移/下移里程碑并与 `BCourseProjectTemplate` 严格对齐 ✅
- [x] **E2-08**: 规则发布后已有项目保持原 `final_deadline` 不受影响 ✅

---

### 五、遗留问题

- 无（进入 Phase 3：操作中心）。
