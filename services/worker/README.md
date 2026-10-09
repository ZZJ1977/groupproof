# Background worker

A1 提供一个可启动、可停止的 worker 进程，并验证 Redis 可达。Celery 任务、SSE 进度和按成员划分的任务目录在 A2/A7 中接入。

未来任务边界：

- `app/tasks/a`：平台和外部同步任务
- `app/tasks/b`：资料分析和任务建议
- `app/tasks/c`：活动和证据处理
- `app/tasks/d`：验收、风险和报告任务
