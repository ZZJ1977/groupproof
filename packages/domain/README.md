# Shared domain contracts

这里存放前后端共用的 OpenAPI 契约快照与自动生成的 TypeScript 接口类型。前端领域模型类型位于 [`shared/types/domain.ts`](../../shared/types/domain.ts)。

## OpenAPI 生成类型

- `openapi.json` 是 `services/api` 当前后端接口契约的可提交快照；后端接口变更后，在 `services/api` 执行 `PYTHONPATH=. python scripts/export_openapi.py` 更新快照（或在后端运行时使用 `OPENAPI_URL=http://localhost:8000/openapi.json npm run api:generate`）。
- `api.generated.ts` 由仓库根目录的 `npm run api:generate`（`scripts/generate-api-client.mjs`）生成，**禁止手工编辑**。CI 会校验后端实时 schema、`openapi.json` 与 `api.generated.ts` 三者一致。
- 前端基础 API 传输层与配置位于 `shared/lib/api-client.ts`、`shared/lib/api-config.ts`；各业务域的真实 API 客户端分置于 `student/api/`、`teacher/api/`、`admin/api/`、`shared/daily-inbox/` 与 `shared/auth/`（已退役的演示模式适配器归档在 `shared/legacy-mock/api/`）。
