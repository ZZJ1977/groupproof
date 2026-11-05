/**
 * Shared URL-state helpers for B pages (B1-01, B4-01, B6).
 *
 * Each page declares a schema; values are read from and written to the query
 * string so refresh, Back/Forward and copied links all restore the same view.
 * Defaults are omitted from the URL to keep shared links short and stable.
 */

export type UrlFilterField =
  | { kind: "enum"; values: readonly string[]; default: string }
  | { kind: "string"; default?: string }
  | { kind: "int"; default: number; min?: number; max?: number }
  | { kind: "list" };

export type UrlFilterSchema = Record<string, UrlFilterField>;

type FieldValue<F extends UrlFilterField> = F extends { kind: "int" } ? number : F extends { kind: "list" } ? string[] : string;

export type UrlFilterValues<S extends UrlFilterSchema> = { [K in keyof S]: FieldValue<S[K]> };
export type UrlFilterPatch<S extends UrlFilterSchema> = { [K in keyof S]?: FieldValue<S[K]> | null };

type QueryLike = { get(name: string): string | null; getAll(name: string): string[] };

function readField(field: UrlFilterField, query: QueryLike, key: string): string | number | string[] {
  if (field.kind === "list") {
    // Accept both ?k=a&k=b and ?k=a,b; drop blanks and duplicates, keep order.
    const parts = query.getAll(key).flatMap((value) => value.split(",")).map((value) => value.trim()).filter(Boolean);
    return [...new Set(parts)];
  }
  const raw = query.get(key);
  if (field.kind === "enum") return raw !== null && field.values.includes(raw) ? raw : field.default;
  if (field.kind === "int") {
    if (raw === null || !/^-?\d+$/.test(raw.trim())) return field.default;
    const value = Number(raw);
    if ((field.min !== undefined && value < field.min) || (field.max !== undefined && value > field.max)) return field.default;
    return value;
  }
  return raw === null ? (field.default ?? "") : raw;
}

export function readUrlFilters<S extends UrlFilterSchema>(schema: S, query: QueryLike): UrlFilterValues<S> {
  const result: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(schema)) result[key] = readField(field, query, key);
  return result as UrlFilterValues<S>;
}

function isDefault(field: UrlFilterField, value: unknown): boolean {
  if (field.kind === "list") return !Array.isArray(value) || value.length === 0;
  if (field.kind === "string") return value === "" || value === (field.default ?? "");
  return value === field.default;
}

/**
 * Apply a patch to an href. `null` or a default value removes the key.
 * Keys outside the schema are left untouched, so other page state survives.
 * Changing any filter other than `page` resets `page` when the schema has one.
 */
export function patchUrlFilters<S extends UrlFilterSchema>(schema: S, currentHref: string, patch: UrlFilterPatch<S>): string {
  const url = new URL(currentHref, "http://local.invalid");
  const keys = Object.keys(patch);
  for (const key of keys) {
    const field = schema[key];
    if (!field) continue;
    const value = patch[key as keyof S];
    url.searchParams.delete(key);
    if (value === null || value === undefined || isDefault(field, value)) continue;
    if (field.kind === "list") url.searchParams.set(key, (value as string[]).join(","));
    else url.searchParams.set(key, String(value));
  }
  if (schema.page && !keys.includes("page") && keys.some((key) => schema[key])) url.searchParams.delete("page");
  return `${url.pathname}${url.search}${url.hash}`;
}

/** Remove every schema key, keeping unrelated parameters such as `view`. */
export function clearUrlFilters<S extends UrlFilterSchema>(schema: S, currentHref: string): string {
  const patch = Object.fromEntries(Object.keys(schema).map((key) => [key, null])) as UrlFilterPatch<S>;
  return patchUrlFilters(schema, currentHref, patch);
}
