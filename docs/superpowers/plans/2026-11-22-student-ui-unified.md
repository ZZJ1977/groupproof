# 学生端统一 UI 与 GitHub AI 摘要实施计划

> **历史归档文档**：本文记录对应阶段的规划/验收快照，不代表当前最新状态；当前架构、实时交付状态与限制请以 [README.md](../../../README.md) 与 [FRONTEND_STATUS.md](../../../FRONTEND_STATUS.md) 为准。

> 本计划在现有学生工作区结构改版之上执行，保留真实 API、权限和 56 个路由。

## Task 1：统一设计令牌和基础组件

- [ ] 扩充 `app/globals.css` 令牌、焦点态、响应式和开放画布布局。
- [ ] 在 `components/common.tsx` 增加 `Section`, `ListRow`, `DetailDrawer`, `Toolbar`, `StateBlock` 等通用组件。
- [ ] 为共享组件增加纯函数/DOM 断言测试。

## Task 2：统一学生工作台壳层

- [ ] 重构 `WorkspaceShell` 的项目上下文、顶部工具栏和移动端抽屉。
- [ ] 保留现有分组导航与深链接，统一间距、选中态、焦点和关闭行为。
- [ ] 验证首页、项目页、课程页和账号页不出现页面级横向溢出。

## Task 3：套用页面模板

- [ ] 首页/课程/项目总览使用摘要 + 连续列表模板。
- [ ] 需求、计划、任务、里程碑、证据、文件、讨论使用列表/详情模板。
- [ ] 设置、绑定、报告和表单使用分段表单模板。
- [ ] 不改教师/管理员信息架构，只共享基础令牌和控件。

## Task 4：GitHub AI 摘要后端

- [ ] 新增通用 `ActivitySummary` 模型、迁移和 DTO。
- [ ] 固化平台无关提示词模板，输入只允许规范化来源字段。
- [ ] 增加生成/读取摘要接口，按活动版本、提示词版本、输入哈希缓存。
- [ ] 首期只处理 commit；证据引用校验失败或 AI 不可用时返回可解释状态。
- [ ] 增加 PostgreSQL/AI provider 单元测试和权限测试。

## Task 5：GitHub 活动前端

- [ ] 列表行显示作者 + 实现内容 + AI 状态。
- [ ] 详情抽屉显示影响范围、验证、风险、证据和原始来源。
- [ ] 支持单条生成、当前页批量生成、失败重试，不影响原始活动。
- [ ] 保留已有筛选、分页、关联任务和审计操作。

## Task 6：综合验收

- [ ] 运行 `npm run lint`, `npm run typecheck`, `npm run build`, `npm run check:routes`, `npm run check:ux`。
- [ ] 运行针对性 API 测试和 workspace-real 浏览器测试。
- [ ] 更新 `FRONTEND_IMPLEMENTATION_PLAN.md`、`FRONTEND_STATUS.md`，记录真实完成项和外部服务限制。
