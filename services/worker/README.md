# Background worker

`services/worker` 是基于 Celery + Redis 的通用后台任务服务，用于执行耗时异步任务并通过 Redis Stream 向 `services/api` 的 SSE 接口推送实时进度。本地 Compose 中的 `worker` 服务运行 `python -m app` 启动 Celery consumer。

## 与线上异步任务服务的分工

当前部署（Railway Staging / Production）中，以下业务后台能力直接随 `services/api` 镜像部署，与 `services/worker` 共享同一 Redis 通道和进度约定：

- **结项报告导出 Worker**：`services/api/railway-report-worker.toml`（`celery -A app.modules.d.report_tasks:celery_app worker --loglevel=info`），负责异步生成 PDF/DOCX 结项报告；开发环境未启动独立 Worker 时自动执行进程内回退。
- **每日风险巡检调度**：`services/api/railway-risk-scheduler.toml`（`python -m scripts.daily_risks --loop`）。
- **GitHub 后台自动同步**：随 `services/api` 进程生命周期运行（`app/modules/a/github_auto_sync.py`）。

`services/worker` 保留通用 `ProgressTask` 框架与各模块任务目录边界，供需要独立扩容与 SSE 进度回放的长耗时任务接入。

## 添加可观察任务

任务模块可以继承 `ProgressTask`，并在每个阶段调用 `self.progress_store.publish`：

```python
@celery_app.task(bind=True, base=ProgressTask, name="app.tasks.example.run")
def run(self, project_id: str):
    self.progress_store.publish(self.request.id, status="STARTED", message="开始")
    # 耗时工作...
    self.progress_store.publish(self.request.id, status="PROGRESS", progress=50, message="一半")
    self.progress_store.publish(self.request.id, status="SUCCESS", progress=100, result={"project_id": project_id})
```

状态写入 `groupproof:task:{task_id}`，事件追加到 `groupproof:task:{task_id}:events`（保留 24 小时，最多 1000 条）。

示例任务 `app.tasks.progress.run_demo_task` 由 API 开发环境的 `POST /api/tasks` 提交；页面连接返回的 `stream_url` 接收 `pending`、`started`、`progress`、`success` 或 `failure` 事件，断线重连时携带 `Last-Event-ID` 即可继续回放。

## 模块任务边界

- `app/tasks/a`：平台和外部同步任务
- `app/tasks/b`：资料分析和任务建议
- `app/tasks/c`：活动和证据处理
- `app/tasks/d`：验收、风险和报告任务
