import { translateText } from "./tr";

const HOST_ATTRS = ["placeholder", "title", "aria-label", "alt", "label", "aria-description", "aria-roledescription"] as const;

function child(value: unknown): unknown {
  if (typeof value === "string") return translateText(value);
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((item) => { const out = child(item); if (out !== item) changed = true; return out; });
    return changed ? next : value;
  }
  return value;
}

/** Translate rendered Chinese text (children everywhere, text attributes on DOM elements). */
export function localizeProps<P>(type: unknown, props: P): P {
  if (!props || typeof props !== "object") return props;
  const source = props as Record<string, unknown>;
  let out: Record<string, unknown> | null = null;
  if ("children" in source) {
    const next = child(source.children);
    if (next !== source.children) { out = { ...source }; out.children = next; }
  }
  if (typeof type === "string") {
    for (const name of HOST_ATTRS) {
      const value = source[name];
      if (typeof value === "string") {
        const next = translateText(value);
        if (next !== value) { out ??= { ...source }; out[name] = next; }
      }
    }
  }
  return (out ?? props) as P;
}
