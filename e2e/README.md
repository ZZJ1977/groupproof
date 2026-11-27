# Playwright 页面测试

应用运行时默认使用真实后端接口（`NEXT_PUBLIC_ENABLE_MOCKS=false`），Staging 与 Production 强制关闭 Mock。`e2e/` 目录包含多套独立的 Playwright 配置，按测试目标区分隔离替身测试与真实联调测试。

## 常用运行命令

在仓库根目录执行：

```bash
npx playwright install chromium

# 默认匿名/基础页面回归（使用内置隔离身份替身 e2e/auth-fixture.mjs，不依赖外部库与凭据）
npm run test:e2e

# Staging/真实模式工作区隔离回归
npm run test:workspace-real

# 教师工作台回归（使用独立 fixture 服务）
npm run test:e2e:teacher
```

其余专用配置（位于仓库根目录）：

- `playwright.b-real.config.ts` / `playwright.b.config.ts`：B 模块课程、小组、项目、需求与任务计划回归
- `playwright.c-api.config.ts` / `playwright.c-daily.config.ts` / `playwright.c-shell.config.ts` / `playwright.c.config.ts`：C 模块 API 与页面契约回归（共用本地 loopback 端口，需串行运行）
- `playwright.c-integration.config.ts`：连接真实 Next.js + FastAPI + 隔离 PostgreSQL 的 C 集成回归
- `playwright.c-storage-staging.config.ts`：Staging 文件上传与冻结版本校验（`npm run test:c5-storage-staging` / `npm run test:c5-freeze-staging`）

默认 `npm run test:e2e`（`playwright.config.ts`）会自动启动内置隔离身份替身（`e2e/auth-fixture.mjs`）和隔离测试环境变量下的 Next.js 开发服务器，因此不要求预先连接线上数据库或第三方凭据；真实全链路浏览器测试请参考 [README.md](../README.md) 与 [docs/qa/student-e2e-test-cases.md](../docs/qa/student-e2e-test-cases.md)。

## 编写新测试

1. 参考现有 `*.spec.ts`（如 `home.spec.ts`、`workspace-real.spec.ts`），使用清晰描述功能的文件名。
2. 使用 `page.goto` 打开目标路由。
3. 优先使用 `getByRole`、`getByLabel` 或 `getByText` 定位用户可见内容。
4. 执行点击、输入等操作后，用 `expect` 断言页面文本、URL、接口状态或控件状态。
5. 切勿在测试或配置中提交真实账号密码、OAuth 凭据或线上数据库地址。
6. 在本地运行对应测试配置确认通过后再提交。

测试失败时可查看 `test-results/` 下的 trace；这些生成文件已列入 `.gitignore`，不会提交到仓库。
