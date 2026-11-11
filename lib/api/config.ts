export const apiFeatures = [
  "workspace",
  "daily",
  "inbox",
  "cworkspace",
  "coursefiles",
  "cidentity",
  "governance",
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
  options: {
    globalMocksEnabled: boolean;
    overrides?: FeatureOverrides;
    /** 正式环境锁：为 true 时一律使用真实接口，忽略任何 mock 开关和单项覆盖。 */
    productionLock?: boolean;
  },
): ApiMode {
  if (options.productionLock) return "real";
  return options.overrides?.[feature] ?? (options.globalMocksEnabled ? "mock" : "real");
}

const globalMocksEnabled = readBoolean(process.env.NEXT_PUBLIC_ENABLE_MOCKS, true);
const featureOverrides = parseFeatureOverrides(process.env.NEXT_PUBLIC_API_FEATURES);
// 正式网站在构建变量里设置 NEXT_PUBLIC_APP_ENV=production，即可保证不会出现示例数据。
const productionLock = process.env.NEXT_PUBLIC_APP_ENV?.trim().toLowerCase() === "production";

export function apiMode(feature: ApiFeature): ApiMode {
  return resolveApiMode(feature, {
    globalMocksEnabled,
    overrides: featureOverrides,
    productionLock,
  });
}

export function isRealApiEnabled(feature: ApiFeature): boolean {
  return apiMode(feature) === "real";
}

export const apiConfig = {
  // Browser cookies and command headers travel through the same-origin proxy.
  // An explicit override is reserved for separately hosted development APIs.
  baseUrl: (process.env.NEXT_PUBLIC_API_BASE_URL || "").replace(/\/$/, ""),
  features: productionLock ? {} : featureOverrides,
};
