export const apiFeatures = [
  "workspace",
  "auth",
  "courses",
  "groups",
  "projects",
  "tasks",
  "evidence",
  "verification",
  "contributions",
  "reports",
  "admin",
] as const;

export type ApiFeature = (typeof apiFeatures)[number];
export type ApiMode = "mock" | "real";

type FeatureOverrides = Partial<Record<ApiFeature, ApiMode>>;

function readBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

export function parseFeatureOverrides(raw: string | undefined): FeatureOverrides {
  if (!raw) return {};

  return raw.split(",").reduce<FeatureOverrides>((result, entry) => {
    const [name, mode] = entry.split(/[=:]/, 2).map((part) => part.trim());
    if (apiFeatures.includes(name as ApiFeature) && (mode === "mock" || mode === "real")) {
      result[name as ApiFeature] = mode;
    }
    return result;
  }, {});
}

export function resolveApiMode(
  feature: ApiFeature,
  options: { globalMocksEnabled: boolean; overrides?: FeatureOverrides },
): ApiMode {
  return options.overrides?.[feature] ?? (options.globalMocksEnabled ? "mock" : "real");
}

const globalMocksEnabled = readBoolean(process.env.NEXT_PUBLIC_ENABLE_MOCKS, true);
const featureOverrides = parseFeatureOverrides(process.env.NEXT_PUBLIC_API_FEATURES);

export function apiMode(feature: ApiFeature): ApiMode {
  return resolveApiMode(feature, { globalMocksEnabled, overrides: featureOverrides });
}

export function isRealApiEnabled(feature: ApiFeature): boolean {
  return apiMode(feature) === "real";
}

export const apiConfig = {
  baseUrl: (process.env.NEXT_PUBLIC_API_BASE_URL || "http://localhost:8000").replace(/\/$/, ""),
  features: featureOverrides,
};
