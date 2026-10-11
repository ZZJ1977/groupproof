# Playwright 页面测试

## 运行示例

在仓库根目录执行：

```bash
npx playwright install chromium
npm run test:e2e
```

Playwright 会自动启动 Next.js 开发服务器。前端当前默认使用 Mock 数据，因此页面测试不需要先启动 FastAPI、PostgreSQL 或 Redis。

## 编写新测试

1. 复制 `home.spec.ts`，改成描述功能的文件名，例如 `courses.spec.ts`。
2. 使用 `page.goto` 打开目标路由。
3. 优先使用 `getByRole`、`getByLabel` 或 `getByText` 定位用户能看到的内容。
4. 执行点击、输入等操作后，用 `expect` 断言页面文本、URL 或控件状态。
5. 在本地执行 `npm run test:e2e`，确认测试通过后再提交。

测试失败时可查看 `test-results/` 下的 trace；这些生成文件不会提交到仓库。
