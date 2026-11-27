# pytest 后端测试

`services/api/tests/` 包含统一认证、Google OIDC、A/B/C/D 业务模块、权限隔离、PostgreSQL 并发与迁移保护，以及 12 阶段全生命周期端到端测试（`test_full_lifecycle_e2e.py` 等 120+ 测试文件）。

## 运行测试

在仓库根目录准备隔离 Python 环境并安装依赖：

```bash
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -r services/api/requirements.txt -r services/api/requirements-dev.txt
```

基础无数据库子集（使用 FastAPI `TestClient` 与隔离测试夹具，跳过依赖 PostgreSQL 的用例）：

```bash
cd services/api
pytest -q
```

完整 PostgreSQL 回归（含迁移、行锁、并发与完整权限矩阵，**0 skipped**）：先启动本地 Compose 数据库并设置三个指向隔离测试库的连接串（严禁指向 Staging/Production 库）：

```bash
docker compose up -d postgres redis
cd services/api
export DATABASE_URL="postgresql+psycopg://gp:gp@127.0.0.1:5432/gp_test"
export C_TEST_DATABASE_URL="$DATABASE_URL"
export C_EXECUTION_TEST_DATABASE_URL="$DATABASE_URL"
alembic upgrade head
pytest -q
```

常用专项检查：

- OpenAPI 快照一致性：`pytest tests/test_openapi_snapshot.py -q`
- Google OIDC 回调/关联回归：`pytest tests/test_auth_google.py -q`
- 12 阶段全生命周期端到端回归：`pytest tests/test_full_lifecycle_e2e.py -q`
- 代码格式与静态检查：`ruff check app tests migrations`、`ruff format --check app tests migrations`

## 编写新测试

1. 按所属模块命名测试文件（如 `test_a_*.py`、`test_b_*.py`、`test_c_*.py`、`test_d_*.py`、`test_auth_*.py`）。
2. 从 `app.main` 导入应用并使用 `TestClient` 发起请求，同时覆盖正常路径、参数错误（`422`）、未登录（`401`）、越权/归档只读（`403`/`404`）及版本冲突（`409`）。
3. 涉及 PostgreSQL 行锁或 Alembic 迁移验证的测试，使用独立临时 schema 或测试库，严禁污染共享数据或依赖个人本地凭据。
4. 外部服务（OIDC、邮件、GitHub、飞书、Supabase、OpenRouter）在单元测试中应使用隔离测试替身，避免真实网络调用。
5. 提交前在 `services/api` 目录执行 `pytest -q` 与 `ruff check` 确认全绿。

pytest 的测试目录与导入路径已在 `services/api/pyproject.toml` 中配置，无需额外创建 `pytest.ini`。
