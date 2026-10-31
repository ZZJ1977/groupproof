# Shared domain contracts

这里存放前后端共用的领域契约、枚举和生成类型。A1 先建立边界；A2 接口契约稳定后再把 `types/domain.ts` 的真实共享模型迁移到这里。

## OpenAPI 生成类型

- `openapi.json` 是当前后端契约的可提交快照；后端运行时可用 `OPENAPI_URL=http://localhost:8000/openapi.json npm run api:generate` 更新。
- `api.generated.ts` 由 `scripts/generate-api-client.mjs` 生成，禁止手工编辑。
- 前端调用统一经过 `lib/api/client.ts`；业务适配器位于 `lib/api/real-service.ts` 和 `lib/api/workspace-service.ts`。
