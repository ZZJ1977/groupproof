# Web application boundary

当前 Next.js 前端仍保留在仓库根目录，以维持现有 Railway Docker 部署。根目录的 `app/`、`components/`、`features/`、`lib/`、`mocks/` 和 `types/` 共同构成这个 web 应用。

`apps/web` 是后续迁移入口；后端开发期间，组员只修改自己负责的前端 feature 和 `services/api/app/modules/<member>`，不直接改其他成员的模块。
