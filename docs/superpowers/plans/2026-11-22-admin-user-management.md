# 用户管理工作台 Implementation Plan

> **历史归档文档**：本文记录对应阶段的规划/验收快照，不代表当前最新状态；当前架构、实时交付状态与限制请以 [README.md](../../../README.md) 与 [FRONTEND_STATUS.md](../../../FRONTEND_STATUS.md) 为准。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 将 `/admin/users` 改造成真实数据驱动的用户目录工作台：可扫读、可筛选、可复现选中用户，并在右侧详情抽屉中完成安全的账号操作。

**Architecture:** 保留 `IdentityAdminApiPages`、`cIdentityClient` 和现有 C 管理接口。目录页使用 URL 查询参数承载筛选/选中项，当前分页数据渲染为语义化表格，详情与动作渲染为可访问抽屉；教师审核继续复用同一数据加载和版本保护逻辑。视觉和响应式规则集中在 `governance.module.css`，不引入新依赖或第二套 API。

**Tech Stack:** Next.js App Router、React、TypeScript、TanStack Query、CSS Modules、Lucide、Playwright。

**Spec:** `docs/superpowers/specs/2026-11-22-admin-user-management-design.md`

## Global Constraints

- 保留 `cIdentityClient` 的 `/api/v1/c-admin` 读写契约，不改用旧的 `/api/v1/admin/users` DTO。
- real 模式不混入 mock；统计只使用当前接口结果，页面内计数必须标明“当前页”。“待验证”只做当前页摘要，不做未被 API 支持的全局快捷筛选。
- 保留 CSRF、已验证学校邮箱、`expectedVersion`、权限失效清敏和通知结果语义。
- 保留现有按钮文案：`新增账号`、`查看`、`处理原因`、`确认停用`、`确认恢复`、`通过`、`拒绝`、`取消`、`刷新列表`、`查询`、`重置`、`下一页`。
- 不添加图表/状态管理依赖，不扩展后端 DTO，不显示凭据、会话或未白名单字段。
- 所有状态同时使用文字与颜色，抽屉支持 Esc、遮罩、焦点回收和窄屏布局。

## Review Focus

- URL 中的 `user` 指向当前页不存在的记录时不能展示过期详情；测试任务 1、3。
- React Query refetch 时应保留可见列表，权限失败后必须清空敏感数据；测试任务 3、4。
- 长邮箱/长学院/多个角色在 375px 不撑破页面；测试任务 2、5。
- `canDisable=false`、未验证邮箱和版本冲突必须给出可执行提示且禁止错误提交；测试任务 3、4。
- 过滤 chip、快捷状态和下拉框必须保持同一 URL 语义，并在重置/换页时清除选中项；测试任务 1、2。

---

### Task 1: 目录状态、URL 查询和展示映射

**Files:**
- Modify: `features/c/IdentityAdminApiPages.tsx`
- Test: `e2e/c-identity-api.spec.ts`

**Interfaces:**
- Consumes: `useUrlQuery`, `IdentityAdminPage<IdentityAdminUser>`, `recordVersion`、`cIdentityClient.users`。
- Produces: `roleLabel`, `statusLabel`, `emailStatusLabel` 展示映射；目录选中项由 `query.get("user")` 读取；筛选和分页更新通过 `updateQuery`。

- [ ] **Step 1: 写失败的 Playwright 断言**：加载目录 fixture 后，断言角色/账号状态/邮箱状态使用中文 badge 文本；点击 `查看` 后 URL 含 `user=identity-student`，刷新仍能看到详情；点击 `重置筛选` 清除筛选和 `user`。
- [ ] **Step 2: 运行聚焦测试确认失败**：运行 `npx playwright test e2e/c-identity-api.spec.ts --grep "URL|中文|重置"`，预期因当前没有 URL 选择/中文映射而失败。
- [ ] **Step 3: 实现查询状态和映射**：在 `IdentityAdminApiPages.tsx` 中将用户选择从本地 `selectedId` 改为 URL `user` 参数；筛选、快捷状态、chip、分页和重置统一更新 `q/role/status/college/page/user`；若 ID 不在当前返回页则清除 `user` 并提示调整筛选；新增中文角色/状态/邮箱验证映射函数，未知枚举回退为可读原值。快捷状态只包含全部/可用/已停用，不新增 `schoolEmailVerified` 查询参数。
- [ ] **Step 4: 计算真实摘要**：由当前 `data.total` 和 `data.items` 计算“结果总数、当前页可用、当前页已停用、当前页待验证”，所有页面内指标显式带“当前页”。refetch 时保留上一次成功数据并显示加载状态。
- [ ] **Step 5: 运行测试确认通过**：重新运行同一 grep，并运行既有 `C7-01/02` 相关测试；预期 URL、中文映射和旧动作流程通过。

### Task 2: 用户目录表格、摘要卡和筛选工具栏

**Files:**
- Modify: `features/c/IdentityAdminApiPages.tsx`
- Modify: `features/governance/governance.module.css`
- Test: `e2e/c-identity-api.spec.ts`
- Test: `scripts/check-admin-pages.mjs`

**Interfaces:**
- Consumes: Task 1 的查询状态、映射函数和摘要数据。
- Produces: `.identitySummary`、`.identityFilters`、`.identityTable`、`.identityFilterChip` 等仅供身份目录使用的结构和样式；保持 `查看` 按钮可定位。

- [ ] **Step 1: 写失败的结构断言**：在 `check-admin-pages.mjs` 增加用户页必须包含“结果总数”“当前页可用”“当前页已停用”“当前页待验证”“重置筛选”“身份/账号状态/学校邮箱”等语义文本；Playwright 断言表头和长邮箱可见。
- [ ] **Step 2: 运行脚本确认失败**：运行 `node scripts/check-admin-pages.mjs`，预期新增结构断言失败。
- [ ] **Step 3: 实现标题区与摘要**：把 `刷新列表`、`新增账号` 放入 `PageHeader.actions`；添加四个摘要卡，空数据显示 `0/—`，不创建趋势或全局假数据。
- [ ] **Step 4: 实现筛选工具栏**：为搜索/学院/角色/状态增加可见 label；学院保持文本输入；添加全部/可用/已停用快捷状态按钮、已生效 chip、`查询` 和 `重置筛选`；提交时回到第 1 页并清除 `user`。
- [ ] **Step 5: 实现语义化表格**：将当前 article rows 改为 table/wrapper，列为用户、学院、角色、账号状态、学校邮箱、操作；多角色用 badge，长文本 `overflow-wrap:anywhere`，当前行使用 `aria-selected`。
- [ ] **Step 6: 运行结构和聚焦测试**：运行 `node scripts/check-admin-pages.mjs` 与 `npx playwright test e2e/c-identity-api.spec.ts --grep "C7-01|C7-02|移动|中文|重置"`，预期全部通过。

### Task 3: 详情抽屉、动作区和键盘交互

**Files:**
- Modify: `features/c/IdentityAdminApiPages.tsx`
- Modify: `features/governance/governance.module.css`
- Test: `e2e/c-identity-api.spec.ts`

**Interfaces:**
- Consumes: Task 1 的 URL `user`、`recordVersion`、现有 `decide`/`refresh` 行为。
- Produces: `role="dialog"` 的详情抽屉，关闭回调清除 `user`，抽屉动作继续调用现有 `cIdentityClient` 写接口。

- [ ] **Step 1: 写失败的抽屉交互测试**：断言点击查看后出现 `aria-modal` 抽屉，列表仍可见；按 `Escape`、点击关闭按钮和遮罩均关闭；关闭后焦点回到触发按钮；移动 viewport 无页面横向溢出。
- [ ] **Step 2: 运行测试确认失败**：运行 `npx playwright test e2e/c-identity-api.spec.ts --grep "抽屉|Escape|焦点|390"`，预期当前 inline panel 不满足。
- [ ] **Step 3: 实现抽屉容器**：添加 backdrop、desktop aside 和 mobile sheet；`useEffect` 记录触发元素、聚焦关闭按钮、处理 Esc/Tab 并在卸载时恢复焦点；详情标题使用稳定 id。
- [ ] **Step 4: 迁移详情内容和动作**：把用户资料、处理原因、停用/恢复迁入抽屉；`canDisable=false` 显示明确提示；底部动作区 sticky，理由为空/冲突/请求中时禁用提交。教师审核页不在本任务内改 URL 或抽屉结构。
- [ ] **Step 5: 保持版本与清敏语义**：刷新只更新 acknowledged version 并保留理由；409 保留输入并锁定动作；401/403 清空目录和抽屉；404 关闭已删除记录并刷新列表。
- [ ] **Step 6: 运行既有动作测试和抽屉测试**：运行完整 `e2e/c-identity-api.spec.ts`，预期创建、停用、恢复、冲突、403、404、教师审核历史全部通过。

### Task 4: 错误反馈、字段提示和创建表单

**Files:**
- Modify: `features/c/IdentityAdminApiPages.tsx`
- Modify: `features/governance/governance.module.css`
- Test: `e2e/c-identity-api.spec.ts`

**Interfaces:**
- Consumes: `ApiError` 的 `status`、`code`、`fieldErrors`、`requestId`、`retryAfterSeconds`。
- Produces: 目录错误重试、字段级错误文案、请求编号显示和邮箱/自账号操作说明；不改变后端 payload。

- [ ] **Step 1: 写失败测试**：模拟 503/422/NETWORK_ERROR 和字段错误，断言出现可执行中文提示、请求编号和“重试”；模拟 `canDisable=false` 与未验证教师申请，断言解释文案可见。
- [ ] **Step 2: 运行测试确认失败**：运行 `npx playwright test e2e/c-identity-api.spec.ts --grep "重试|请求编号|字段|不能停用|验证"`。
- [ ] **Step 3: 扩展错误映射**：让 `message` 覆盖 401/403/409/422/503/0，并附加 requestId；列表错误旁添加重试；错误状态不渲染旧敏感详情。
- [ ] **Step 4: 补齐表单提示**：创建表单根据 `fieldErrors` 在字段旁显示错误并保留输入；教师通过按钮旁说明必须先验证学校邮箱；当前管理员不可停用时说明原因。
- [ ] **Step 5: 运行测试确认通过**：重新运行错误/表单 grep 及完整 identity e2e。

### Task 5: 响应式、文档与工程验收

**Files:**
- Modify: `features/governance/governance.module.css`
- Modify: `docs/development-stages/stage-reports/2026-11-22-admin-backend.md` (create if absent)
- Test: `scripts/check-admin-pages.mjs`

**Interfaces:**
- Consumes: Tasks 1–4 的 DOM 类名、状态和测试。
- Produces: 375/768/1024px 可用的用户目录，并记录实际限制和验证结果。

- [ ] **Step 1: 写样式结构断言**：检查抽屉、表格 wrapper、移动 breakpoint 和 focus-visible 样式类存在。
- [ ] **Step 2: 实现响应式样式**：桌面抽屉固定右侧且列表保持可见；≤768px 改全宽 sheet；表格在窄屏转为可读卡片/横向滚动而不造成 body overflow；操作区 sticky。
- [ ] **Step 3: 运行前端验证**：`node scripts/check-admin-pages.mjs`、`npx playwright test e2e/c-identity-api.spec.ts`、`npm run lint`、`npm run typecheck`、`npm run build`、`npm run check:routes`、`git diff --check`。
- [ ] **Step 4: 更新阶段报告**：记录使用的 `/api/v1/c-admin` 契约、真实数据边界、桌面/移动验证、未扩展的 DTO 字段和剩余限制。
- [ ] **Step 5: 提交**：仅提交本次用户管理改动、设计/计划和阶段报告，保留工作区已有的无关未跟踪文件。

