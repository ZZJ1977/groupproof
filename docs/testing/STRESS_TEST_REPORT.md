# GroupProof 并发压力测试报告

> 测试基线：`origin/develop` @ `6255870`（Alembic 迁移头 `0047`）· 测试日期：2026-11-25
> 返回 [项目首页](../../README.md) · 另见 [本地开发、测试与部署指引](../guide/LOCAL_AND_DEPLOY.md)

本报告汇总针对 GroupProof 后端与 Railway Staging 环境的分阶段并发压力测试结果，全部数据均来自可复现脚本的实测记录，客观呈现吞吐、延迟分布、锁竞争行为、真实瓶颈与测试覆盖边界。

---

## 1. 测试环境与架构配置

| 维度 | Phase 1：本地隔离 PostgreSQL 16 + FastAPI | Phase 2：Railway Staging 线上公网只读压测 |
| --- | --- | --- |
| 测试对象 | `uvicorn app.main:app --host 127.0.0.1 --port 18080 --workers 1`（与 `services/api/scripts/entrypoint.sh` 单 worker 部署配置一致） | `groupproof`（API）+ `groupproof-staging`（Next.js Web），公网入口 `https://groupproof-staging-production.up.railway.app`（未触碰 Production） |
| 硬件与运行时 | Apple M4（10 核）/ 16 GB RAM / macOS；Python 3.12.13、FastAPI 0.115.6、Uvicorn 0.34.0、SQLAlchemy 2.0.36、psycopg 3.2.3 | Railway 云端托管容器（单副本 Next.js Web → 内网代理至单 worker FastAPI） |
| 数据库与连接池 | 本地 Docker PG 16.15（`pgvector/pgvector:pg16`，`max_connections=100`），隔离库 `groupproof_stress`（`0047 head`）；SQLAlchemy 连接池 `pool_size=15`、`max_overflow=25`（上限 40）、`pool_timeout=15s`、`pool_recycle=1800s`、`pool_pre_ping=True` | Railway 托管 PostgreSQL 16（`0047 head`），与生产隔离 |
| 测试数据集 | 1 名已审核教师、4 名已验证学校邮箱学生（Argon2id + 真实 Cookie/CSRF 会话）、1 门课程（含邀请码）、2 个小组、1 个课程项目（3 模块 / 15 任务 / 15 证据 / 冻结基线与计划）、1 个独立项目 | 非破坏性公开只读接口（4 个真实 200 路由，每并发档位 100 请求，不写库、不滥用配额） |

---

## 2. Phase 1 实测数据（本地 PG16 全栈读写与锁竞争）

全程 **0 次 HTTP 5xx、0 次客户端异常、0 次 PostgreSQL 死锁/序列化冲突、0 次 `QueuePool TimeoutError`**。

### 2.1 Test A：读并发阶梯（每档 300 请求，覆盖 10 个 GET 接口）

> 覆盖路由含 `/healthz`、`/readyz`、`/api/v1/auth/session`、`/api/v1/me`、`/api/v1/projects/{id}/overview`、`/api/v1/projects/{id}/tasks`、`/api/v1/projects/{id}/evidence`、`/api/v1/teacher/classes/{course_id}`、`/api/v1/teacher/classes/{course_id}/reports/overview`、`/api/v1/courses/{course_id}/teacher-overview`。

| 并发数 (`c`) | 总耗时 (s) | 吞吐 (QPS) | P50 (ms) | P95 (ms) | P99 (ms) | Max (ms) | HTTP 状态分布 |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| `10` | 1.483 | **202.24** | 42.22 | 101.97 | 112.52 | 129.94 | `200`: 300 |
| `30` | 1.589 | **188.83** | 131.18 | 321.45 | 386.68 | 406.99 | `200`: 300 |
| `50` | 1.681 | **178.48** | 237.98 | 522.22 | 568.36 | 609.96 | `200`: 300 |

- **`c=50` 最慢三类聚合读接口**：
  - `GET /api/v1/projects/{id}/evidence`：P50 `494.3ms`、P95 `560.5ms`、Max `610.0ms`
  - `GET /api/v1/teacher/classes/{course_id}/reports/overview`：P50 `484.4ms`、P95 `566.0ms`、Max `584.6ms`
  - `GET /api/v1/projects/{id}/tasks`：P50 `401.8ms`、P95 `480.5ms`
- 无库查询的 `GET /healthz` P50 亦从 `c=10` 时的 `7.2ms` 上升至 `c=50` 时的 `54.0ms`，反映单 worker 同步处理线程与 GIL 排队效应。

### 2.2 Test B：写并发与锁竞争

| 场景 | 并发与请求量 | 总耗时 (s) | 吞吐 (QPS) | P50 (ms) | P95 (ms) | P99 (ms) | Max (ms) | 结果与数据一致性 |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| **B.1 `attach-course` 竞态** | `c=20`，20 个不同 `Idempotency-Key` 并发移入同一独立项目 | 0.095 | 211.64 | 82.32 | 91.21 | 92.00 | 92.20 | **`200`: 1、`409 (PROJECT_ALREADY_IN_COURSE)`: 19**；0 5xx / 0 死锁；数据库仅产生 1 次合法绑定 |
| **B.2 并发项目写入** | `c=20`（10 路 `PATCH /tasks/{id}/progress` + 10 路 `POST /projects/{id}/discussions`） | 0.251 | 79.64 | 146.03 | 235.69 | 246.07 | 248.67 | **`200`: 10**（进度 P50 `126.7ms`，Max `184.1ms`，10 项任务在项目行锁串行化下全部持久化为 65%）、**`201`: 10**（讨论 P50 `186.2ms`，Max `248.7ms`） |

### 2.3 Test C：连接池饱和突发（`c=80` 混合读写）

- **负载构成**：80 并发、共 400 次请求（300 次读 + 100 次 `POST /projects/{id}/discussions`）。
- **总体指标**：总耗时 `3.443s` | 吞吐 **`116.19 QPS`** | P50 `349.10ms` | P95 `1608.30ms` | P99 `2091.59ms` | Max `2949.37ms` | **`200`: 300、`201`: 100**（0 5xx、0 超时）。
- **尾部延迟**：`GET /evidence` P95 `2143.9ms` / Max `2949.4ms`；`POST /discussions` P50 `744.8ms` / P95 `1468.6ms` / Max `2329.9ms`；`GET /readyz` P95 `1725.7ms` / Max `1881.3ms`。
- **数据库事后统计**：`discussions=110`（B.2 的 10 条 + C 的 100 条完整落盘），`deadlocks=0`，`conflicts=0`，`xact_commit=1830`，`xact_rollback=831`（主要为 GET 请求结束时回滚 `touch_session()` 产生的脏会话变更）。

---

## 3. Phase 2 实测数据（Railway Staging 公网只读并发）

针对线上 Staging 的 4 个真实公开 `200` 接口（`GET /healthz`、`GET /login`、`GET /api/v1/auth/session`、`GET /api/v1/auth/capabilities`，每档 100 次请求，每接口 25 次）执行温和并发基准测试：**300/300 返回 HTTP 200，0 次 5xx，0 次客户端异常**（含预检与首轮探测共计 668 次请求全部 0 5xx）。

### 3.1 并发阶梯汇总

| 并发数 (`c`) | 总耗时 (s) | 吞吐 (QPS) | Min (ms) | P50 (ms) | P95 (ms) | P99 (ms) | Max (ms) | HTTP 状态分布 |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| `10` | 7.008 | 14.27 | 226.12 | 396.80 | 1870.35 | 3366.10 | 5334.23 | `200`: 100 |
| `20` | 3.291 | 30.39 | 221.52 | 265.52 | 1419.83 | 2038.35 | 2175.32 | `200`: 100 |
| `30` | 2.913 | 34.33 | 221.90 | 364.19 | 1661.96 | 2050.55 | 2078.83 | `200`: 100 |

### 3.2 `c=30` 分接口延迟明细（各 25 请求，100% HTTP 200）

| 接口 | 链路 | P50 (ms) | P95 (ms) | P99 (ms) | Max (ms) |
| --- | --- | ---: | ---: | ---: | ---: |
| `GET /api/v1/auth/session` | Next.js Web → FastAPI 内网代理 | 248.76 | 1365.04 | 1896.49 | 2050.26 |
| `GET /api/v1/auth/capabilities` | Next.js Web → FastAPI 内网代理 | 267.79 | 1575.42 | 1715.07 | 1730.02 |
| `GET /healthz` | Next.js Web 自身 | 327.90 | 1247.04 | 1854.28 | 2015.66 |
| `GET /login` | Next.js SSR 页面渲染 | **671.56** | 1597.71 | 1978.71 | 2078.83 |

- **公网基线与代理开销**：公网 RTT 下限约 `222ms`（本地回环为 `3.4ms`）；短突发建连阶段 TCP/TLS 握手叠加云端边缘抖动构成 `1.4–1.9s` P95 尾延迟（`c=10` 出现单次 `5.33s` 离群点）。热连接下 Web → FastAPI 内网代理仅增加约 `20–45ms` 开销，与本地后端表现一致。

---

## 4. 测试结果说明什么

### 4.1 当前可安全承载的课堂负载

- **典型高校课程班（30–60 人）同时浏览、更新进度、发讨论或并发点击「移入课程」**：系统在本地单 worker 实测 50 并发读保持 `178 QPS`（P50 `238ms`）、80 并发混合突发仍保持 **0 错误 / 0 死锁 / 0 连接池超时**，线上 Staging 30 并发 100% 返回 200。
- **竞态与数据完整性可靠**：20 路并发 `attach-course` 严格返回 `1 × 200 + 19 × 409`，10 路并发进度更新在项目行锁保护下全部正确持久化，不会出现重复绑定、脏写或死锁。

### 4.2 本次测试未覆盖的范围（诚实边界）

1. **长耗时 AI / LLM 任务**：未压测 OpenRouter 需求分析、AI 验收评审及 7 章节结项报告生成/PDF 导出（这些接口受外部 LLM 延迟与后台线程/Worker 吞吐主导）。
2. **线上 Staging 认证后写压测与大班数据量**：Phase 2 仅压测公开只读接口；Phase 1 种子为单班 15 任务/15 证据，若单班扩展至 10–30 个小组、数百任务与数千条证据，聚合查询耗时将高于本报告基线。
3. **跨小时长稳与内存泄漏测试**：本次为短时高并发阶梯与突发测试，未做小时级浸泡压测。

### 4.3 识别出的 3 个真实瓶颈与优化建议

| # | 实测瓶颈 | 量化证据 | 针对性优化建议 |
| --- | --- | --- | --- |
| 1 | **单 Uvicorn Worker + GIL + AnyIO 40 线程上限** | 本地吞吐在 `c=10` 达峰（`202 QPS`）后于 `c=30/50` 回落至 `189/178 QPS`，延迟随并发线性增长；`c=80` 时超出 40 线程的请求在 AnyIO 队列等待（恰好等于 `pool_size(15)+max_overflow(25)=40`，避免连接池超时） | 业务量增长后可在 `entrypoint.sh` 扩展为 2–4 个 Uvicorn workers，同时将单 worker `pool_size`/`max_overflow` 相应下调（例如 `8+12=20`），确保 `workers × max_pool < PG max_connections`；将 `/healthz` 改为 `async def` 避免受同步线程池排队影响 |
| 2 | **`touch_session()` 每次请求写脏会话** | `app/auth/guard.py:read_session()` 在每个已登录请求上查询多张认证表并无条件修改 `auth_sessions.last_seen_at`/`expires_at`；Phase 1 产生 `831` 次 `xact_rollback`（主要为 GET 关闭会话回滚），且同用户并发写会在 `auth_sessions` 行锁上串行化 | 对 `touch_session()` 增加节流窗口（如距上次 `last_seen_at` 超过 5 分钟才更新），并对纯读 GET 路径避免产生不必要的 ORM 脏写入 |
| 3 | **重聚合读接口与 Next.js `/login` SSR 渲染开销** | 本地 `/evidence`、`/reports/overview`、`/tasks` 耗时为 `/auth/session` 的 5–7 倍；线上 Staging `/login` SSR P50 在 `c=20→30` 从 `415.7ms` 升至 `671.6ms`，使总 QPS 在 `30–34 QPS` 趋平 | 为证据列表、任务列表、教师报告总览补齐复合索引与预聚合查询（消除 N+1），必要时对静态/登录页启用边缘缓存或提升 Web 副本数 |

---

## 5. 全流程 AI 成本测算（基于 OpenRouter 实测账单）

本节基于 Railway Staging 数据库 `a_ai_usage_events` 记录的真实 OpenRouter 调用账单（统计区间 `2026-11-23 08:20 ~ 2026-11-26 13:18 +08`，共 `751` 次调用：成功 `624` 次、失败 `127` 次，其中 `742` 条含 OpenRouter 计价，累计输入 `8,406,794` tokens、输出 `566,122` tokens，总花费 **`USD 3.786016`**），结合当前现网生效模型配置，对单个课程小组全周期 AI 成本进行测算（汇率按 `1 USD ≈ 7.2 RMB` 折算）。

### 5.1 现网模型配置与各业务场景实测单次成本

当前现网生效环境变量：`AI_PROVIDER=openrouter`、`AI_MODEL=deepseek/deepseek-v3.2`（日常分析）、`AI_REPORT_WRITING_MODEL=google/gemini-2.5-flash` 与 `AI_REPORT_VISUAL_MODEL=google/gemini-2.5-flash`（7 章节结项报告与图表规划）。

| 业务场景 (`feature`) | 现网模型 | 实测样本 | 单次成功均值 | 单次中位数 | 平均 Token（输入 / 输出） | 说明 |
| --- | --- | --- | ---: | ---: | --- | --- |
| **GitHub 提交摘要** (`summarize_activity`) | `deepseek/deepseek-v3.2` | 476 成功 / 113 失败 | **USD 0.002467**（约 ¥0.018） | USD 0.001355 | 9,716 / 610（失败均 28,696 / 776） | 含失败（均价 USD 0.006303）589 次综合均价 **USD 0.003203**，累计花费 USD 1.886 |
| **证据智能匹配** (`match_evidence`) | `deepseek/deepseek-v3.2` | 115 成功 | **USD 0.000359**（约 ¥0.0026） | USD 0.000341 | 983 / 243 | 极低单次成本 |
| **飞书群聊协作分析** (`analyze_feishu_collaboration`) | `deepseek/deepseek-v3.2` | 3 成功 | **USD 0.009830**（约 ¥0.071） | USD 0.009326 | 23,542 / 7,266 | 单次上下文跨多天群聊记录，Token 较长 |
| **风险解读** (`explain_risk`) | `deepseek/deepseek-v3.2` | 3 成功 | **USD 0.000550**（约 ¥0.004） | USD 0.000642 | 2,307 / 125 | 成本可忽略 |
| **完整 7 章结项报告 + 视觉图表**（`part1+2+3+visuals`） | `google/gemini-2.5-flash` | 实测组合合计 | **约 USD 0.041 / 份**（约 ¥0.30） | — | ~10k / ~10k（4 步合计） | 含局部段落重试约 **USD 0.05 / 份（¥0.36）**；若切换为 `anthropic/claude-sonnet-4.5` 则实测约 **USD 0.58 / 份（¥4.2）**，贵约 14 倍 |
| **需求分析 / 任务规划 / AI 逐条验收** | `deepseek/deepseek-v3.2` | *暂无实测样本* | *估算约 USD 0.003 / 次* | — | *未实测* | 按同类 `deepseek-v3.2` 上下文规模保守估算，非数据库账单实测值 |

> 补充说明：Staging 历史开发期总账单达到 `USD 3.786016` 的主要原因有二：① 早期测试报告生成时短暂使用 `anthropic/claude-sonnet-4.5`（12 次调用花费 `USD 1.695`，占历史总额 `44.8%`，现网已切换至 `gemini-2.5-flash`）；② 本仓库自身累计 538 次提交且因调试/历史重写重扫触发 `summarize_activity` 589 次，花费 `USD 1.886`（占 `49.8%`）。

### 5.2 单小组全过程与整班整学期费用测算（现网配置）

| 作业规模档位 | 假设全周期 AI 调用频次 | 预计单组总费用 (USD) | 折合人民币 (RMB) | 人均分摊（按 4 人组） | 整班参考（15 组 / 60 人） |
| --- | --- | :---: | :---: | :---: | :---: |
| **1. 普通课程大作业**<br>（3–4 人，10–15 项任务） | 提交摘要 60 次、证据匹配 20 次、飞书分析 2 次、规划/验收 15 次、结项报告 2 份 | **USD 0.32 – 0.40** | **¥2.3 – ¥2.9** | **约 ¥0.6 – ¥0.7** | **USD 5 – 6（¥35 – ¥45）** |
| **2. 标准软件工程项目**<br>（4–5 人，25–30 项任务） | 提交摘要 150 次、证据匹配 60 次、飞书分析 4 次、规划/验收 30 次、结项报告 3 份 | **USD 0.68 – 0.80** | **¥4.9 – ¥5.8** | **约 ¥1.2 – ¥1.5** | **USD 10 – 12（¥75 – ¥90）** |
| **3. 重度高频开发项目**<br>（对标 GroupProof，34 项任务） | 提交摘要 500 次（含大 diff 重试）、证据匹配 115 次、飞书分析 5 次、规划/验收 40 次、结项报告 5 份 | **USD 1.70 – 2.10** | **¥12.2 – ¥15.1** | **约 ¥3.1 – ¥3.8** | **USD 26 – 32（¥185 – ¥230）** |

### 5.3 成本结构洞察、测算边界与降本建议

1. **主要成本驱动因素是 `summarize_activity` 而非结项报告**：在现网 `gemini-2.5-flash` 下，生成一整套 7 章结项报告加图表仅约 **¥0.36**；日常真正占总账单 `65%–75%` 的是高频率 GitHub 提交摘要（平均每次摄入近 1 万输入 Token）。
2. **大 diff 失败调用明显放大支出**：`summarize_activity` 在 Staging 实测有 `19.2%` 失败率（`113/589`），失败请求平均输入达 `28,696` tokens、单次均价 `USD 0.006303`，为成功均价的 **2.55 倍**，仅失败重试便消耗 **`USD 0.712`**。
3. **针对性降本措施**：对 `summarize_activity` 严格收紧单次 diff 字节截断上限、跳过纯锁文件/自动生成文件/微小改动提交，或改由用户点击详情时按需生成摘要，预计可将标准软件工程小组全周期 AI 费用进一步压低至 **¥2 – ¥3 / 组**。
4. **测算边界说明**：
   - `a_ai_usage_events` 中有 `9` 条早期失败调用未返回计价字段（`cost IS NULL`，均为 0 token 或早期错误），未计入成功均值；
   - 需求分析、任务规划与 AI 逐条验收在 Staging 库内尚无真实调用样本，表中为估算值；
   - 若开放全班学生频繁反复点击「重新生成结项报告」或切换回高单价模型，实际开销将随之放大，运营期需配合管理员后台 `/admin/ai-usage` 监控异常调用与配额。
