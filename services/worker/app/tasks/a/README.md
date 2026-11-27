# A worker tasks

预留给基于 `services/worker` `ProgressTask` 的平台、认证与外部同步长耗时任务；输入输出契约保持在 `packages/domain` 中可追踪。当前 GitHub 定时自动同步随 API 进程运行于 `services/api/app/modules/a/github_auto_sync.py`。
