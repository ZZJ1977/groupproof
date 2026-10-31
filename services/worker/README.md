# Background worker

worker 使用 Celery + Redis 执行耗时任务。Compose 中的 `worker` 服务运行
`python -m app`，它会启动 Celery consumer；任务结果和实时进度存放在 Redis，API
通过 SSE 读取同一条事件流。

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

状态会写入 `groupproof:task:{task_id}`，事件追加到
`groupproof:task:{task_id}:events`。事件保留 24 小时，最多保留 1000 条。

示例任务 `app.tasks.progress.run_demo_task` 由 API 开发环境的
`POST /api/tasks` 提交；页面可以连接返回的 `stream_url`，接收 `pending`、`started`、
`progress`、`success` 或 `failure` 事件。断线后带上 `Last-Event-ID` 即可从上次位置继续。

任务边界：

- `app/tasks/a`：平台和外部同步任务
- `app/tasks/b`：资料分析和任务建议
- `app/tasks/c`：活动和证据处理
- `app/tasks/d`：验收、风险和报告任务
