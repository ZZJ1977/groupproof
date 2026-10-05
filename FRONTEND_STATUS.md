# GroupProof V1 前端交付状态

更新日期：2026-10-05

## 已完成

- 已按《UI 设计合集》纳入全部 56 页。逐页名称和实际 URL 见 [`FRONTEND_IMPLEMENTATION_PLAN.md`](./FRONTEND_IMPLEMENTATION_PLAN.md#56-页路由映射)。其中任务树、看板、列表对应同一任务数据集的三种视图。
- 基础入口 01–06、个人动态 30；项目启动、任务、里程碑与验收 07–20；开发协作、贡献、报告与设置 21–29；课程与小组 31–40；教师端 41–50；Admin 51–56。
- Next.js App Router、TypeScript strict、Tailwind CSS、本地 shadcn/ui 风格控件、Lucide 图标、TanStack Query、React Hook Form + Zod、next-intl 中文环境。
- 学生/组长、教师/助教、Admin 三套导航和前端角色入口。桌面优先，并在窄屏使用抽屉导航和可横向滚动的密集表格。
- 六步项目初始化、需求基线版本、任务规划、共享 Task Tree/Board/List、任务详情、证据提交/完整性检查、逐项 AI 验收与人工确认、课程组队及变更、教师处理、Admin 教师审核均有可操作状态。
- 搜索、筛选、Tab、Dialog、Dropdown、表单和 Admin 用户分页可操作。通知已读、任务状态等变更跨视图更新并在本机浏览器刷新后保留。

## Mock 数据与服务

- [`mocks/seed.ts`](./mocks/seed.ts) 使用稳定 ID 关联 Course → Group → Project → Requirement → Functional Module → Task/Subtask → Acceptance Criterion → Evidence → Verification → Contribution → Report，并包含通知、待处理、GitHub、飞书、教师和审计样本。
- [`lib/api/mock-service.ts`](./lib/api/mock-service.ts) 以 Promise 提供数据读取，浏览器 `localStorage` 保存演示状态；[`lib/workspace.tsx`](./lib/workspace.tsx) 提供 TanStack Query 缓存、集合级新增/更新/移除和角色切换。相关任务/证据/标准变更会使当前验收结果失效。
- Mock 登录、学校邮箱验证码、AI 分析/验收、GitHub/飞书同步、文件上传记录、审批和报告生成均在浏览器本地模拟。权限为前端演示门禁，不构成真实鉴权。

## 待后端与真实集成

- FastAPI：身份与权限校验、课程/小组/项目/任务/证据/验收/贡献/报告业务 API、状态机与并发版本检查、审批、审计日志、文件元数据及访问控制。替换 Mock Adapter 时需保持当前领域对象和操作契约。
- 数据与存储：PostgreSQL/Supabase 持久化、文件对象存储、Redis/Celery 后台任务、SSE 进度推送；当前都没有连接。
- 第三方：Google OAuth、GitHub 仓库/Commit/PR/CI 同步、飞书只读协作记录、AI 需求分析和验收。这些页面目前只使用关联的 Mock 记录与模拟动作。
- 导出：PDF 目前调用浏览器打印；Word 下载为 HTML 兼容的 `.doc` 演示文件。正式 PDF/DOCX 生成应由后端或专门导出服务接管。

## 已知限制与设计差异

- 视觉按 56 页设计稿的布局、信息层级与配色重建，使用可维护的共享组件；未做逐像素复刻。少量长表格在手机上横向滚动。
- 当前 Mock 贡献份额是可追溯样本快照，任务/证据变化不会重新计算正式贡献比例；正式规则和异议裁定等待后端实现。
- 邮箱输入任意 6 位数字可模拟通过；Google 登录、教师审核身份与管理员访问控制都需要服务端校验。
- 资料上传只保存文件名、大小等浏览器内的 Mock 元数据，不保存文件内容；SSE 和真实异步作业尚未接入。
- Profile 中的语言字段尚未提供完整英文词条，当前产品界面以中文为准。
- `npm audit --omit=dev --audit-level=moderate` 为 0 漏洞。完整开发依赖审计仍报告 `eslint-config-next → fast-glob → micromatch → braces` 的 5 项高危传递告警；目前上游没有同主版本的修复路径，生产依赖不受该报告影响。

## 验证与运行

- `npm install`、`npm run lint`、`npm run typecheck`、`npm run build`、`npm run check:routes` 均通过。
- 运行开发服务器时，`CHECK_HTTP=1 npm run check:routes` 验证 56 个设计页路由全部返回 HTTP 200。
- 浏览器检查了首页、登录、课程、任务三视图/状态同步、验收、通知筛选与已读、报告、教师总览、Admin 用户分页与教师审核，并查看桌面和窄屏布局。
- 启动：`npm run dev -- --port 3000`，打开 `http://localhost:3000/`。右上角演示角色选择器可切换学生、组长、教师、助教和管理员。

## 目录

```text
app/                 App Router 入口与全局样式
components/          工作区导航、共用展示和 UI 控件
features/core/       登录、首页、通知、待办、个人动态
features/project-core/ 项目启动、需求、任务、里程碑、证据、验收
features/project-support/ 开发协作、贡献、报告、项目设置
features/course/     课程和小组工作流
features/governance/ 教师与 Admin 页面
lib/api/             Mock 服务适配器
lib/                 路由解析、工作区状态与工具
mocks/               关联种子数据
types/               领域类型
scripts/             56 路由检查
```
