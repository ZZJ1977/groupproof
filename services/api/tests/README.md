# pytest 后端测试

## 运行示例

在仓库根目录执行：

```bash
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -r services/api/requirements.txt -r services/api/requirements-dev.txt
cd services/api
pytest -q
```

当前示例位于 `test_health.py`，使用 FastAPI 的 `TestClient` 直接调用应用，不需要启动独立的 API 进程。

`test_database.py` 是 PostgreSQL 集成测试示例。先启动本地 Compose 数据库并执行 `alembic upgrade head`，再设置 `DATABASE_URL` 后运行 `pytest -q`；没有设置连接串时，该文件会跳过，不影响只测试 HTTP 路由的本地运行。

## 编写新测试

1. 复制 `test_health.py`，改成描述功能的文件名，例如 `test_projects.py`。
2. 从 `app.main` 导入应用，使用 `TestClient` 发起请求。
3. 为正常响应、参数错误、未登录、无权限和资源不存在等路径分别写断言。
4. 涉及数据库或外部服务时，使用测试夹具替换真实依赖，避免测试依赖个人本地数据。
5. 在 `services/api` 目录执行 `pytest -q`，确认测试通过后再提交。

pytest 的测试目录和 Python 导入路径已经在 `pyproject.toml` 中配置，不需要额外创建 `pytest.ini`。
