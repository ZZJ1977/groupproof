export type ParsedEvidenceDetails = {
  commitTag: string | null;
  implementation: string | null;
  impact: string | null;
  verification: string | null;
  changedFiles: string[];
  originalCommit: string | null;
  otherLines: string[];
};

const IMPLEMENTATION_PREFIXES = ["实现内容：", "AI 代码实现分析："] as const;

/** Parses structured AI/GitHub commit metadata lines from evidence descriptions for compact expandable display. */
export function parseEvidenceDetails(
  title: string,
  description: string | null | undefined,
): ParsedEvidenceDetails {
  const titleMatch = title.match(/^\[([0-9a-f]{6,12})\]/i);
  let commitTag = titleMatch ? titleMatch[1] : null;
  let implementation: string | null = null;
  let impact: string | null = null;
  let verification: string | null = null;
  let changedFiles: string[] = [];
  let originalCommit: string | null = null;
  const otherLines: string[] = [];

  for (const rawLine of (description ?? "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    const implPrefix = IMPLEMENTATION_PREFIXES.find((prefix) => line.startsWith(prefix));
    if (implPrefix) {
      implementation = line.slice(implPrefix.length).trim() || null;
      continue;
    }
    if (line.startsWith("影响范围：")) {
      impact = line.slice("影响范围：".length).trim() || null;
      continue;
    }
    if (line.startsWith("验证说明：")) {
      verification = line.slice("验证说明：".length).trim() || null;
      continue;
    }
    if (line.startsWith("改动文件：")) {
      const rawFiles = line.slice("改动文件：".length).trim();
      changedFiles = rawFiles
        .split(/[、,，]/)
        .map((part) => part.trim())
        .filter(Boolean);
      continue;
    }
    if (line.startsWith("原提交：")) {
      originalCommit = line.slice("原提交：".length).trim() || null;
      if (!commitTag && originalCommit) {
        const hashMatch = originalCommit.match(/\(([0-9a-f]{6,12})\)/i);
        if (hashMatch) commitTag = hashMatch[1];
      }
      continue;
    }
    otherLines.push(line);
  }

  return {
    commitTag,
    implementation,
    impact,
    verification,
    changedFiles,
    originalCommit,
    otherLines,
  };
}
