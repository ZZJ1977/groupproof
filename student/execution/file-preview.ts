export type PreviewKind = "markdown" | "image" | "pdf" | "text" | "binary";

const markdownExtensions = new Set(["md", "markdown", "mdown"]);
const imageExtensions = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg"]);
const textExtensions = new Set([
  "txt", "log", "json", "csv", "tsv", "ts", "tsx", "js", "jsx", "mjs", "py", "java", "c", "cc", "cpp", "h", "hpp", "go", "rs",
  "sh", "bash", "zsh", "yml", "yaml", "toml", "ini", "cfg", "conf", "env", "xml", "html", "htm", "css", "scss", "sql", "rb", "php",
  "swift", "kt", "vue", "svelte", "gitignore", "dockerfile",
]);

/** Max bytes of text read into the viewer; larger files are truncated with a notice. */
export const PREVIEW_TEXT_LIMIT = 512 * 1024;

function extensionOf(name: string, extension?: string) {
  const fromName = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1) : "";
  return (extension || fromName).replace(/^\./, "").toLowerCase();
}

export function previewKind(version: { original_name: string; extension?: string; mime_type?: string }): PreviewKind {
  const ext = extensionOf(version.original_name, version.extension);
  const mime = (version.mime_type ?? "").split(";", 1)[0].trim().toLowerCase();
  if (markdownExtensions.has(ext) || mime === "text/markdown" || mime === "text/x-markdown") return "markdown";
  if (imageExtensions.has(ext) || mime.startsWith("image/")) return "image";
  if (ext === "pdf" || mime === "application/pdf") return "pdf";
  if (textExtensions.has(ext) || mime.startsWith("text/") || mime === "application/json") return "text";
  return "binary";
}

export function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** Reads at most `limit` bytes of a text response and reports whether it was cut. */
export async function readTextLimited(response: Response, limit = PREVIEW_TEXT_LIMIT): Promise<{ text: string; truncated: boolean }> {
  if (!response.body) {
    const text = await response.text();
    return text.length > limit ? { text: text.slice(0, limit), truncated: true } : { text, truncated: false };
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let received = 0;
  let text = "";
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > limit) {
      text += decoder.decode(value.subarray(0, value.byteLength - (received - limit)), { stream: true });
      truncated = true;
      await reader.cancel();
      break;
    }
    text += decoder.decode(value, { stream: true });
  }
  text += decoder.decode();
  return { text, truncated };
}
