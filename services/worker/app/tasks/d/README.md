# D worker tasks

预留给基于 `services/worker` `ProgressTask` 的验收匹配、风险解释与长耗时报告任务。当前线上的 PDF/DOCX 报告导出 Celery Worker 与每日风险巡检调度分别位于 `services/api/app/modules/d/report_tasks.py`（`services/api/railway-report-worker.toml`）和 `services/api/scripts/daily_risks.py`（`services/api/railway-risk-scheduler.toml`）。
