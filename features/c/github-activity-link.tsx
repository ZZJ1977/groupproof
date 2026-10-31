import { githubEvidenceUrl } from "./evidence-source";

/** C owns activity records; OAuth and repository connection controls stay with A. */
export function GithubActivityLink({ url, title, className }: { url?: string; title: string; className?: string }) {
  const href = githubEvidenceUrl(url ?? "");
  return href
    ? <a className={className} href={href} target="_blank" rel="noopener noreferrer">{title}</a>
    : <span>{title}<span className="ml-2 text-xs text-slate-500">来源链接不可用</span></span>;
}
