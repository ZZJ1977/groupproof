# GroupProof 学生端全流程交互测试案例与验收报告

- **验收日期**：2026-11-22
- **测试环境**：真实构建 Next.js 15（`NEXT_PUBLIC_ENABLE_MOCKS=false`）+ 真实 FastAPI 后端（`services/api`）+ 真实 Chromium 浏览器（Playwright，无前端 API Mock 拦截）
- **自动化脚本**：`scripts/run-student-full-lifecycle-e2e.mjs` + `scripts/student_e2e_backend.py`
- **执行结果**：**17 / 17 全部通过（0 Console Error，0 非预期 5xx，移动端 390px 零横向溢出）**

---

## 本次验收期间发现并修复的真实缺陷

1. **项目报告页 CSRF 缺失导致 403**：`features/d/ReportApiPage.tsx` 原使用 `useApp().session?.csrfToken` 静态值，已统一升级为 `fetchWithSession` 动态携带最新 `X-CSRF-Token`，修复“生成新版本”和“导出 PDF/DOCX”在真实会话下报 `403 Forbidden` 的问题。
2. **GitHub 活动仅同步默认分支且缺少页内同步入口**：后端 `github.py` / `github_activity.py` 升级为默认分支 + `develop` 等活跃分支多分支同步（自动按 SHA 去重），并新增验签 Webhook `POST /api/v1/webhooks/github`；前端 `ActivityApiPages.tsx` 顶栏新增**「同步 GitHub」**与**「同步飞书记录」**直连同步按钮，并清洗 PR 模板 HTML 注释与重复标题行。
3. **侧边栏项目名未回显 & 权限回收泄露**：`components/workspace-shell.tsx` 修复为读取真实项目名（不再固定显示“项目”），且权限失效（403）时立即清空隐藏旧项目名。
4. **需求新增后下方“需求清单”未即时刷新**：`features/b/RequirementsSteps.tsx` 补全 `b-req-list` 缓存失效，新增或 AI 分析后下方列表实时同步。
5. **项目设置“项目语言”输入框未限制 16 字符导致 422**：`features/d/ProjectSettingsApiPage.tsx` 补齐 `maxLength={16}` 与准确示例文案。
6. **里程碑页重复主标题 & D 模块 5 页无样式原型**：`route-dispatcher.tsx` 为嵌入式风险区传入 `embedded` 消除重复 `<h1>`；统一升级风险、验收、贡献、报告、项目设置 5 页及全局学生端设计体系（分段胶囊标签、轻量化开放画布、柔和景深卡片与统一圆角控件）。

---

## 全流程交互测试案例清单（供逐项人工复核）

| 用例编号 | 模块 / 阶段 | 测试场景与操作步骤 | 预期结果 | 实测结果 |
| --- | --- | --- | --- | --- |
| **TC-01** | 认证与首页 | 访问 `/login`，输入真实学生邮箱与密码点击登录 | 校验凭据并下发会话 Cookie，自动跳转 `/home` 展示学生工作台 | ✅ PASS（844ms） |
| **TC-02** | 课程加入与资料 | 访问 `/courses/join` 输入邀请码回车预览 → 确认加入 → 进入 `/courses/:id/rules` 与 `/courses/:id/files` | 预览准确课程信息并成功入课；可读正式课程规则与教师发布的课程资料 `课程实训大纲-v1.md` | ✅ PASS（1841ms） |
| **TC-03** | 组队与课程立项 | 访问 `/courses/:id/groups` 创建小组 → 访问 `/courses/:id/projects/new` 完成 3 步向导创建课程项目 | 小组创建成功（自动成为组长），课程项目落库并自动跳转 `/projects/:id` | ✅ PASS（1657ms） |
| **TC-04** | 导航与全局搜索 | 检查左侧边栏项目徽章 → 在顶栏搜索框输入“闭环系统” | 左侧边栏实时显示真实项目名；顶栏防抖搜索返回本项目入口（严格遵循 RBAC） | ✅ PASS（302ms） |
| **TC-05** | 资料上传与正文提取 | 访问 `/projects/:id/setup`，上传 `.md` 需求说明书文件 | 触发内联上传与正文提取，状态显示**「正文已就绪」** | ✅ PASS（696ms） |
| **TC-06** | 需求工作区与基线冻结 | 访问 `/projects/:id/requirements` → 点**「开始分析」** → 手工添加模块与需求 → 切至**「基线确认」**完成范围/清单/负责人并提交冻结 | 分段胶囊标签切换顺畅；AI 草案与手工需求共存；基线冻结成功并自动固化课程文件版本引用 | ✅ PASS（2086ms） |
| **TC-07** | 任务规划与三视图 | 访问 `/projects/:id/tasks/plan` 新增带验收标准任务（权重 100）→ 成员确认并发布计划 → 依次访问 `view=tree/board/list` | 计划冻结成功；任务树、看板、列表三视图共享同一任务数据，展示一致 | ✅ PASS（2473ms） |
| **TC-08** | GitHub 多分支直连同步 | 在 `/projects/:id/settings` 绑定仓库 → 进入 `/projects/:id/github` 点顶栏**「同步 GitHub」** → 点**「生成摘要」** | 一键同步 `main` + `develop` 分支提交、PR 与 CI；PR 模板注释被清洗不污染列表；AI 提交摘要生成并标记“AI 已生成 · 待人工确认” | ✅ PASS（2851ms） |
| **TC-09** | 任务执行与正式证据 | 开始任务 → 更新进度至 100% → 准备提交 → 保存实现说明 → 提交候选证据并采纳为正式证据 → 访问 `/projects/:id/evidence` | 100% 进度不会自动完成任务（保持进行中）；实现说明与正式证据在详情与证据中心可见 | ✅ PASS（1276ms） |
| **TC-10** | 里程碑与风险跟踪 | 访问 `/projects/:id/milestones` → 检查无重复主标题 → 创建风险记录 → 点**「生成风险解释」** | 仅一个主标题，风险 KPI 汇总实时更新，AI 风险解读正常展示 | ✅ PASS（858ms） |
| **TC-11** | 完整性检查与人工验收 | 访问 `/tasks/:tid/evidence-check` 点**「重新检查」** → **「进入验收」** → 访问 `/verification` 点**「运行自动验收」** → 填判断原因与 `100%` 承担比例点**「确认验收结果」** | 覆盖率 100%，生成 AI 逐条建议后经负责人人工确认生成正式成果，任务状态变更为已完成 | ✅ PASS（2970ms） |
| **TC-12** | 贡献计算与快照冻结 | 访问 `/projects/:id/contribution` → 点**「按当前正式成果重新计算」** → 点**「确认并冻结贡献快照」** | 展示成员 100% 权重积分进度条，贡献快照冻结成功并出现“前往项目报告 →”引导 | ✅ PASS（840ms） |
| **TC-13** | 结项报告与真实导出 | 访问 `/projects/:id/reports/export` 点**「生成新版本」** → 导出并校验 PDF / DOCX 二进制流 → 访问 `/reports` 预览 | 无 403/500 错误；真实 PDF（`%PDF` 头，3,620B）与 DOCX（`PK` 头，37,499B）可正常下载，预览状态显示“已生成” | ✅ PASS（1410ms） |
| **TC-14** | 讨论区与项目设置 | 访问 `/projects/:id/discussions` → 访问 `/projects/:id/settings` 修改项目类型与项目语言（≤16 字符）并点击**「保存设置」** | 讨论区正常加载；项目设置保存成功并显示“已保存”反馈 | ✅ PASS（1363ms） |
| **TC-15** | 首页统计实时回显 | 返回 `/home` 检查统计卡片与项目行 | “我的已完成任务”更新为 `1`，项目行显示“任务进度：100%”及“GitHub 已连接 · 1 个仓库” | ✅ PASS（644ms） |
| **TC-16** | 移动端响应式校验 | 切换 `390×844` 移动端视口访问 `/projects/:id/github` | 顶栏折叠为抽屉菜单，筛选区与活动行自适应堆叠，横向溢出 `0px` | ✅ PASS（683ms） |
| **TC-17** | 控制台与接口健康度 | 统计全流程 16 项交互期间所有浏览器 Console Error 与非预期 5xx | **0 Console Error，0 非预期 5xx** | ✅ PASS（0ms） |

---

## 外部平台与线上环境补充核验项（人工上线抽检）

以下依赖第三方外部平台配置的能力，已在代码中完成完整链路与异常处理，线上验收时按需核对：

1. **GitHub Webhook 自动推送同步**：在 GitHub App 设置页配置 Webhook URL 为 `https://<你的域名>/api/v1/webhooks/github`、并在 Railway API 设置相同 `GITHUB_WEBHOOK_SECRET` 后，仓库每次 `push` / `pull_request` / `workflow_run` 将自动刷新项目活动，无需手动点同步。
2. **飞书历史消息同步**：绑定飞书群与机器人在群校验已打通；若需拉取历史群消息，需确保飞书开放平台应用已开启并发布群消息读取权限。
