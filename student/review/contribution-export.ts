import type { BTaskRow } from "@/student/api/b-tasks";
import type { ProjectContributionAnalytics } from "@/student/review/contribution-analytics";

const TASK_STATUS_LABEL: Record<string, string> = {
  completed: "已完成",
  pending_verification: "待人工确认",
  pending_submission: "待提交",
  in_progress: "进行中",
  not_started: "未开始",
};

function statusLabel(status: string): string {
  return TASK_STATUS_LABEL[status] ?? status;
}

function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("zh-CN", { hour12: false });
}

function safeFileStem(projectName: string): string {
  const cleaned = projectName.replace(/[\\/:*?"<>|]+/g, "-").trim() || "GroupProof";
  const stamp = new Date().toISOString().slice(0, 10);
  return `${cleaned}-贡献分析报告-${stamp}`;
}

function triggerDownload(filename: string, content: string, mimeType: string) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function snapshotStatusLabel(analytics: ProjectContributionAnalytics): string {
  const s = analytics.snapshot;
  if (!s) return "未计算";
  if (s.stale) return `历史快照 v${s.version}（成果已变更，需重算）`;
  return s.status === "frozen" ? `已冻结 v${s.version}` : `草稿 v${s.version}`;
}

function assigneesLabel(task: BTaskRow): string {
  if (!task.assignees.length) return "未指派";
  return task.assignees.map((a) => a.name || "成员").join("、");
}

export function buildMarkdownReport(analytics: ProjectContributionAnalytics): string {
  const exportedAt = new Date().toLocaleString("zh-CN", { hour12: false });
  const snapLabel = snapshotStatusLabel(analytics);
  const lines: string[] = [
    `# ${analytics.projectName} · 团队贡献数据分析报告`,
    "",
    `- **导出时间**：${exportedAt}`,
    `- **正式贡献快照**：${snapLabel}`,
    `- **计算模型**：${analytics.snapshot?.formula_version ?? "formal-task-weight-x-confirmed-responsibility-v1"}`,
    `- **数据透明度说明**：**正式验收权重**仅基于人工确认通过的正式成果与责任占比计算并用于结项冻结；**全过程综合活跃参考**综合任务推进、GitHub 提交与飞书协作关联，仅供团队复盘参考。`,
    "",
    "## 一、项目总览指标",
    "",
    "| 指标 | 数值 | 说明 |",
    "| --- | --- | --- |",
    `| 团队成员总数 | ${analytics.members.length} 人 | 正式成果计入 ${analytics.formalParticipantCount} 人，活跃参与 ${analytics.activeContributorCount} 人 |`,
    `| 任务完成进度 | ${analytics.taskStatusCounts.completed} / ${analytics.taskStatusCounts.total} | 待人工确认 ${analytics.taskStatusCounts.pendingVerification} 项，进行中 ${analytics.taskStatusCounts.inProgress} 项 |`,
    `| 正式任务积分合计 | ${analytics.totalFormalCredit} | 已冻结或待冻结正式成果权重总和 |`,
    `| GitHub 代码活动 | ${analytics.totalCommits} 次提交 | 新增 +${analytics.totalAdditions} / 删除 -${analytics.totalDeletions} 行，PR ${analytics.totalPullRequests} 次 |`,
    `| 飞书协作记录 | ${analytics.feishuTotalMessages} 条消息 | AI 协作结论 ${analytics.feishuInsights?.items.length ?? 0} 项 |`,
    "",
    "## 二、全员多维贡献明细",
    "",
    "| 成员 | 正式权重占比 | 正式积分 | 正式成果数 | 任务完成 / 指派 | 加权任务进度 | GitHub 提交 | 代码增删 (+/-) | 协作关联数 | 综合活跃参考 |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
  ];

  for (const m of analytics.members) {
    lines.push(
      `| ${m.name} | ${m.formalShare.toFixed(1)}% | ${m.taskCredit} | ${m.formalTasks.length} | ${m.completedCount} / ${m.assignedCount} | ${m.weightedTaskProgress}% | ${m.commits} | +${m.additions} / -${m.deletions} | ${m.collabRecords} | ${m.activityShare.toFixed(1)}% |`,
    );
  }

  lines.push("", "## 三、项目任务状态与分工明细", "");
  if (analytics.tasks.length === 0) {
    lines.push("暂无项目任务记录。");
  } else {
    lines.push(
      "| 编号 | 任务名称 | 状态 | 进度 | 权重 | 负责人 | 关联提交 | 验收标准确认 |",
      "| --- | --- | --- | ---: | ---: | --- | ---: | ---: |",
    );
    for (const t of analytics.tasks) {
      const criteriaText = `${t.criteria_confirmed ?? 0}/${t.criteria_total ?? 0}`;
      lines.push(
        `| ${t.code ?? "—"} | ${t.title.replaceAll("|", "\\|")} | ${statusLabel(t.status)} | ${t.progress_percent}% | ${t.weight} | ${assigneesLabel(t)} | ${t.matched_commits ?? 0} | ${criteriaText} |`,
      );
    }
  }

  lines.push("", "## 四、正式成果与证据追溯", "");
  const membersWithFormal = analytics.members.filter((m) => m.formalTasks.length > 0);
  if (membersWithFormal.length === 0) {
    lines.push("当前尚未有已确认的正式验收成果。");
  } else {
    for (const m of membersWithFormal) {
      lines.push(`### ${m.name}（正式权重 ${m.formalShare.toFixed(1)}%，积分 ${m.taskCredit}）`, "");
      for (const ft of m.formalTasks) {
        lines.push(
          `- **${ft.title}**：任务权重 ${ft.weight}，承担比例 ${ft.responsibility_share}%，关联正式证据 ${ft.evidence.length} 份`,
        );
      }
      lines.push("");
    }
  }

  return `${lines.join("\n")}\n`;
}

export function buildWordHtmlReport(analytics: ProjectContributionAnalytics): string {
  const exportedAt = new Date().toLocaleString("zh-CN", { hour12: false });
  const snapLabel = snapshotStatusLabel(analytics);
  const memberRows = analytics.members
    .map(
      (m) => `
      <tr>
        <td><strong>${escapeHtml(m.name)}</strong></td>
        <td class="num">${m.formalShare.toFixed(1)}%</td>
        <td class="num">${m.taskCredit}</td>
        <td class="num">${m.formalTasks.length}</td>
        <td class="num">${m.completedCount} / ${m.assignedCount}</td>
        <td class="num">${m.weightedTaskProgress}%</td>
        <td class="num">${m.commits}</td>
        <td class="num">+${m.additions} / -${m.deletions}</td>
        <td class="num">${m.collabRecords}</td>
        <td class="num">${m.activityShare.toFixed(1)}%</td>
      </tr>`,
    )
    .join("");

  const taskRows = analytics.tasks
    .map(
      (t) => `
      <tr>
        <td>${escapeHtml(t.code ?? "—")}</td>
        <td>${escapeHtml(t.title)}</td>
        <td>${escapeHtml(statusLabel(t.status))}</td>
        <td class="num">${t.progress_percent}%</td>
        <td class="num">${t.weight}</td>
        <td>${escapeHtml(assigneesLabel(t))}</td>
        <td class="num">${t.matched_commits ?? 0}</td>
      </tr>`,
    )
    .join("");

  return `<!DOCTYPE html>
<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word" lang="zh-CN">
<head>
<meta charset="utf-8" />
<title>${escapeHtml(analytics.projectName)} 贡献数据分析报告</title>
<style>
  body { font-family: "PingFang SC", "Microsoft YaHei", "SimSun", sans-serif; color: #0f172a; line-height: 1.55; margin: 28px; font-size: 10.5pt; }
  h1 { font-size: 18pt; color: #0f172a; border-bottom: 2px solid #0369a1; padding-bottom: 8px; margin-bottom: 12px; }
  h2 { font-size: 13pt; color: #0369a1; margin-top: 22px; margin-bottom: 8px; }
  .meta { background: #f8fafc; border: 1px solid #e2e8f0; padding: 10px 14px; border-radius: 6px; margin-bottom: 14px; font-size: 9.5pt; color: #334155; }
  .note { background: #eff6ff; border-left: 4px solid #0369a1; padding: 8px 12px; margin: 12px 0; font-size: 9.5pt; color: #1e3a8a; }
  table { border-collapse: collapse; width: 100%; margin-top: 8px; font-size: 9.5pt; }
  th, td { border: 1px solid #cbd5e1; padding: 6px 8px; text-align: left; }
  th { background: #f1f5f9; font-weight: bold; color: #1e293b; }
  td.num, th.num { text-align: right; }
</style>
</head>
<body>
  <h1>${escapeHtml(analytics.projectName)} · 团队贡献数据分析报告</h1>
  <div class="meta">
    <div><strong>导出时间：</strong>${escapeHtml(exportedAt)}</div>
    <div><strong>贡献快照状态：</strong>${escapeHtml(snapLabel)}（最近计算：${escapeHtml(formatDateTime(analytics.snapshot?.calculated_at))}）</div>
    <div><strong>核心汇总：</strong>团队成员 ${analytics.members.length} 人（正式计入 ${analytics.formalParticipantCount} 人） · 任务完成 ${analytics.taskStatusCounts.completed}/${analytics.taskStatusCounts.total} · 代码提交 ${analytics.totalCommits} 次（+${analytics.totalAdditions} / -${analytics.totalDeletions}） · 飞书消息 ${analytics.feishuTotalMessages} 条</div>
  </div>
  <div class="note">
    <strong>学术与评审口径说明：</strong>“正式权重占比”严格依据已人工确认的正式成果与责任占比计算并用于结项冻结；“综合活跃参考”综合任务进度、GitHub 代码提交与飞书协作关联，仅作为过程复盘参考。
  </div>

  <h2>一、全员多维贡献明细</h2>
  <table>
    <thead>
      <tr>
        <th>成员</th>
        <th class="num">正式权重</th>
        <th class="num">正式积分</th>
        <th class="num">正式成果</th>
        <th class="num">任务完成/指派</th>
        <th class="num">任务进度</th>
        <th class="num">代码提交</th>
        <th class="num">代码增删</th>
        <th class="num">协作关联</th>
        <th class="num">综合活跃参考</th>
      </tr>
    </thead>
    <tbody>${memberRows}</tbody>
  </table>

  <h2>二、项目任务执行明细（共 ${analytics.tasks.length} 项）</h2>
  <table>
    <thead>
      <tr>
        <th>编号</th>
        <th>任务名称</th>
        <th>状态</th>
        <th class="num">进度</th>
        <th class="num">权重</th>
        <th>负责人</th>
        <th class="num">关联提交</th>
      </tr>
    </thead>
    <tbody>${taskRows || '<tr><td colspan="7">暂无任务记录</td></tr>'}</tbody>
  </table>
</body>
</html>`;
}

export function buildExcelXmlReport(analytics: ProjectContributionAnalytics): string {
  const xmlHeader = `<?xml version="1.0" encoding="UTF-8"?>
<?mso-application progid="Excel.Sheet"?>`;

  const cellStr = (value: string, styleId = "Default") =>
    `<Cell ss:StyleID="${styleId}"><Data ss:Type="String">${escapeXml(value)}</Data></Cell>`;
  const cellNum = (value: number, styleId = "Num") =>
    `<Cell ss:StyleID="${styleId}"><Data ss:Type="Number">${Number.isFinite(value) ? value : 0}</Data></Cell>`;

  const memberHeader = [
    "成员姓名",
    "正式权重(%)",
    "正式任务积分",
    "正式成果数",
    "指派任务数",
    "已完成任务数",
    "待人工确认数",
    "加权任务进度(%)",
    "GitHub 提交数",
    "代码新增行",
    "代码删除行",
    "PR 数量",
    "协作关联数",
    "综合活跃参考(%)",
  ]
    .map((h) => cellStr(h, "Header"))
    .join("");

  const memberXmlRows = analytics.members
    .map(
      (m) => `<Row>
        ${cellStr(m.name)}
        ${cellNum(Number(m.formalShare.toFixed(2)))}
        ${cellNum(m.taskCredit)}
        ${cellNum(m.formalTasks.length)}
        ${cellNum(m.assignedCount)}
        ${cellNum(m.completedCount)}
        ${cellNum(m.pendingVerificationCount)}
        ${cellNum(m.weightedTaskProgress)}
        ${cellNum(m.commits)}
        ${cellNum(m.additions)}
        ${cellNum(m.deletions)}
        ${cellNum(m.pullRequests)}
        ${cellNum(m.collabRecords)}
        ${cellNum(Number(m.activityShare.toFixed(1)))}
      </Row>`,
    )
    .join("");

  const taskHeader = ["任务编号", "任务标题", "状态", "进度(%)", "权重", "负责人", "关联提交数", "已确认标准", "标准总数"]
    .map((h) => cellStr(h, "Header"))
    .join("");

  const taskXmlRows = analytics.tasks
    .map(
      (t) => `<Row>
        ${cellStr(t.code ?? "—")}
        ${cellStr(t.title)}
        ${cellStr(statusLabel(t.status))}
        ${cellNum(t.progress_percent)}
        ${cellNum(t.weight)}
        ${cellStr(assigneesLabel(t))}
        ${cellNum(t.matched_commits ?? 0)}
        ${cellNum(t.criteria_confirmed ?? 0)}
        ${cellNum(t.criteria_total ?? 0)}
      </Row>`,
    )
    .join("");

  return `${xmlHeader}
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"
  xmlns:o="urn:schemas-microsoft-com:office:office"
  xmlns:x="urn:schemas-microsoft-com:office:excel"
  xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">
  <Styles>
    <Style ss:ID="Default" ss:Name="Normal">
      <Font ss:FontName="PingFang SC" ss:Size="11"/>
      <Alignment ss:Vertical="Center"/>
    </Style>
    <Style ss:ID="Title">
      <Font ss:FontName="PingFang SC" ss:Size="13" ss:Bold="1" ss:Color="#0369A1"/>
    </Style>
    <Style ss:ID="Header">
      <Font ss:FontName="PingFang SC" ss:Size="11" ss:Bold="1" ss:Color="#0F172A"/>
      <Interior ss:Color="#F1F5F9" ss:Pattern="Solid"/>
      <Borders>
        <Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#CBD5E1"/>
      </Borders>
    </Style>
    <Style ss:ID="Num">
      <Alignment ss:Horizontal="Right" ss:Vertical="Center"/>
    </Style>
  </Styles>
  <Worksheet ss:Name="成员贡献汇总">
    <Table>
      <Row>${cellStr(`${analytics.projectName} · 团队贡献数据分析（${snapshotStatusLabel(analytics)}）`, "Title")}</Row>
      <Row>${cellStr(`导出时间：${new Date().toLocaleString("zh-CN", { hour12: false })} | 正式权重仅以已确认正式成果为准，综合活跃参考仅供过程复盘`)}</Row>
      <Row>${memberHeader}</Row>
      ${memberXmlRows}
    </Table>
  </Worksheet>
  <Worksheet ss:Name="任务进度明细">
    <Table>
      <Row>${cellStr(`${analytics.projectName} · 任务分解与完成明细（共 ${analytics.tasks.length} 项）`, "Title")}</Row>
      <Row>${taskHeader}</Row>
      ${taskXmlRows}
    </Table>
  </Worksheet>
</Workbook>`;
}

export type ContributionExportFormat = "markdown" | "word" | "excel";

export function exportContributionReport(
  analytics: ProjectContributionAnalytics,
  format: ContributionExportFormat,
) {
  const stem = safeFileStem(analytics.projectName);
  if (format === "markdown") {
    triggerDownload(`${stem}.md`, buildMarkdownReport(analytics), "text/markdown;charset=utf-8");
    return;
  }
  if (format === "word") {
    triggerDownload(`${stem}.doc`, `\uFEFF${buildWordHtmlReport(analytics)}`, "application/msword;charset=utf-8");
    return;
  }
  triggerDownload(`${stem}.xls`, buildExcelXmlReport(analytics), "application/vnd.ms-excel;charset=utf-8");
}
