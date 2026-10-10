# API service

这是 FastAPI 模块化单体的入口。A1 只提供运行骨架和 `/healthz`，业务模块由各成员在自己的目录中实现。

目录边界：

- `app/modules/a`：A 负责的认证、平台和外部接入
- `app/modules/b`：B 负责的课程、项目初始化和任务计划
- `app/modules/c`：C 负责的活动、证据和管理后台
- `app/modules/d`：D 负责的验收、贡献、报告和教师端
- `tests`：后端测试
- `migrations`：唯一的 Alembic 迁移目录，所有结构变化都必须提交迁移文件

## 数据库迁移

API 使用 PostgreSQL/pgvector、SQLAlchemy 2.x 和 Alembic。连接串从 `DATABASE_URL` 读取，默认时区为 `Asia/Shanghai`，可用 `DATABASE_TIMEZONE` 覆盖。

在 `services/api` 目录执行：

```bash
alembic upgrade head
python -m scripts.seed_core
alembic current
alembic downgrade -1  # 仅用于本地验证回滚
```

`python -m scripts.seed_core` 只创建本地演示数据，重复执行安全；生产环境不要把演示数据当作业务初始化数据。
