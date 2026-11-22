# GroupProof Admin Console Visual Refresh Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 将现有 `/admin/*` 改造成统一的浅色数据工作台，保留真实 API、环境切换、权限和路由契约。

**Architecture:** 复用 `WorkspaceShell`、治理 primitives、`GovernanceApiPages`、`AdminDashboardPage` 和现有 API 客户端。先在共享 CSS/组件层建立 admin tokens、卡片、工具栏、表格和详情抽屉的视觉基线，再调整首页与业务页的结构。趋势和分布图使用 CSS/SVG 轻量渲染，不增加图表依赖。

**Tech Stack:** Next.js App Router、React、TypeScript、Tailwind、CSS Modules、Lucide、TanStack Query。

**Spec:** `docs/superpowers/specs/2026-11-22-admin-console-visual-refresh-design.md`

## Global Constraints

- 保留所有 `/admin/*` 路由、API 客户端、环境 cookie 和权限边界。
- real 模式不混入 mock 数据，空数据不生成虚假趋势或增长率。
- 不新增图表依赖，不加载外部字体，不暴露敏感审计字段。
- 状态同时使用文字和颜色，支持键盘焦点、加载、空、错误和窄屏状态。
- 用户明确要求不出现指定品牌词，新增界面文案不包含该词。

## Review Focus

- 环境切换后查询缓存和页面指标必须对应当前环境。测试任务 2、3。
- API 返回空数据或 503 时，卡片和图表必须显示可解释空/错误状态。测试任务 2、4。
- 长邮箱、UUID、事件详情和表格在 375/768px 不溢出。测试任务 1、4。
- AI 用量为零或缺失费用/Token 时，不能显示误导性的增长率或费用。测试任务 3。
- 管理页面主要按钮、焦点环和状态标签必须有可读名称。测试任务 1、4。

### Task 1: 建立管理后台视觉基础

**Files:**
- Modify: `components/workspace-shell.tsx`
- Modify: `app/globals.css`
- Modify: `features/governance/governance.module.css`
- Modify: `features/governance/primitives.tsx`
- Test: `scripts/check-admin-ui.mjs` (create)

**Interfaces:**
- `WorkspaceShell` 继续接收 `kind="admin"`，只改变 admin 分支的导航分组和呈现。
- `Header`, `Box`, `Metric`, `Badge`, `Table` 保持现有导出名称和调用签名。
- 新增 CSS Module 类名只供治理页面和 admin shell 使用。

- [ ] **Step 1: 写 UI 结构断言**，检查 admin 导航包含总览、用户、教师审核、课程、日志、AI 使用、访问审批，检查共享组件仍导出既有名称。
- [ ] **Step 2: 更新 admin shell**，把侧栏导航分成“平台管理 / 运行分析”两组，保留顶部环境切换和账户菜单，增加当前环境的辅助文本。
- [ ] **Step 3: 更新 tokens 与治理 CSS**，实现浅色画布、圆角卡片、紧凑工具栏、状态 badge、表格 hover、固定表头、详情面板和响应式断点。
- [ ] **Step 4: 更新 primitives**，让 Header 支持页头 eyebrow/动作区域，Metric 支持趋势提示和语义 tone，Box/Table 复用新的卡片和滚动容器样式。
- [ ] **Step 5: 运行 `node scripts/check-admin-ui.mjs`、`npm run lint`、`npm run typecheck`**，确认无结构回归。

### Task 2: 重做管理总览看板

**Files:**
- Modify: `features/c/AdminDashboardPage.tsx`
- Modify: `features/governance/governance.module.css`
- Test: `scripts/check-admin-dashboard.mjs` (create)

**Interfaces:**
- 继续使用 `cIdentityClient.users/applications` 和 `createGovernanceClient.courses/accessRequests`。
- 不改变现有 query key 和 API 参数，新增的活动区只能使用已返回数据或明确的空状态。

- [ ] **Step 1: 写看板结构断言**，检查 KPI、活动趋势、待处理事项、最近账号、账号结构、课程状态和连接状态的语义标题存在。
- [ ] **Step 2: 将 Header 和 KPI 改成参考图式的标题行与四卡片布局**，在零数据时显示“暂无数据”或“—”，不显示虚构百分比。
- [ ] **Step 3: 增加轻量活动概览组件**，用已有最近账号/待办数据生成可解释的列表和空态，服务状态保留可重试入口。
- [ ] **Step 4: 调整分布卡片**，使用环形/进度视觉表达角色与课程状态，保留数字和文字标签。
- [ ] **Step 5: 在 1440/1024/768/375 宽度运行页面检查并执行 `npm run check:routes`**。

### Task 3: 重构 AI 用量看板

**Files:**
- Modify: `features/c/GovernanceApiPages.tsx`
- Modify: `features/governance/governance.module.css`
- Test: `scripts/check-ai-usage-ui.mjs` (create)

**Interfaces:**
- 继续使用 `UsageQuery` 和 `api.usage` 返回的 `daily/by_model/by_feature` 数据。
- 保留 `usageScenarioDefinitions`、OpenRouter 来源说明、费用/Token 完整性字段和现有筛选 URL 参数。

- [ ] **Step 1: 写用量看板断言**，检查来源、时间范围、请求/费用/Token/成功率 KPI、趋势、业务场景和模型明细。
- [ ] **Step 2: 将筛选区压缩成单一工具栏**，时间范围用 segmented controls，用户/功能/模型使用同一行查询操作。
- [ ] **Step 3: 将 KPI 与趋势区改成分析看板**，零请求显示空态，缺失计费和 Token 继续使用警示状态。
- [ ] **Step 4: 将业务场景做成带进度条和可读描述的分布卡片**，明确 GitHub 提交分析、群聊证据追踪、需求解析、任务规划、风险解释。
- [ ] **Step 5: 保留模型/日期明细表并验证无横向溢出，运行 `npm run lint`、`npm run typecheck`**。

### Task 4: 统一业务管理台与日志详情

**Files:**
- Modify: `features/c/IdentityAdminApiPages.tsx`
- Modify: `features/c/GovernanceApiPages.tsx`
- Modify: `features/governance/AdminViews.tsx`
- Modify: `features/governance/governance.module.css`
- Test: `scripts/check-admin-workbench.mjs` (create)

**Interfaces:**
- 保留真实目录、教师审核、课程生命周期、共享日志、认证日志和业务日志的 API 契约。
- 详情仍通过 URL query 选择，刷新和返回行为保持可复现。

- [ ] **Step 1: 写管理工作台断言**，检查标题行主操作、紧凑筛选栏、表格、状态标签、分页和空态。
- [ ] **Step 2: 将用户目录和课程页的新增/刷新操作移动到标题行，统一筛选工具栏和表格行高。**
- [ ] **Step 3: 将教师审核的状态计数和审核动作做成队列式布局，保留邮箱验证前置条件。
- [ ] **Step 4: 将共享日志详情从内嵌 `details` 改为可访问的详情面板/抽屉，默认缩略 ID，保留后端脱敏标记和前后快照。
- [ ] **Step 5: 在 375px 和 768px 验证表格滚动、键盘焦点、长文本和错误重试，运行完整前端检查。

### Task 5: 文档、截图与最终验收

**Files:**
- Modify: `docs/development-stages/stage-reports/2026-11-22-admin-backend.md`
- Create: `docs/design/screenshots/admin-refresh-*.png` (when browser capture is available)

- [ ] **Step 1: 启动 Web 开发服务并访问 `/admin`、`/admin/users`、`/admin/logs`、`/admin/ai-usage`。
- [ ] **Step 2: 分别切换 develop/main，确认环境标识和查询结果随环境变化。
- [ ] **Step 3: 运行 `npm run lint`、`npm run typecheck`、`npm run build`、`npm run check:routes`。
- [ ] **Step 4: 在阶段报告记录实际改动、验证结果和仍需真实数据支持的限制。
