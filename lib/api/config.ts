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
    /** 部署环境锁：为 true 时一律使用真实接口，忽略任何 mock 开关和单项覆盖。 */
    productionLock?: boolean;
  },
): ApiMode {
  if (options.productionLock) return "real";
  return options.overrides?.[feature] ?? (options.globalMocksEnabled ? "mock" : "real");
}

export function resolveApiEnvironment(environment: {
  appEnv?: string;
  enableMocks?: string;
  features?: string;
}) {
  const appEnv = environment.appEnv?.trim().toLowerCase();
  return {
    globalMocksEnabled: readBoolean(environment.enableMocks, false),
    overrides: parseFeatureOverrides(environment.features),
    productionLock: appEnv === "production" || appEnv === "staging",
  };
}

// NEXT_PUBLIC_* values are compiled into the client bundle. Both deployed environments
// prohibit demo data; isolated development/test harnesses must opt in explicitly.
const environment = resolveApiEnvironment({
  appEnv: process.env.NEXT_PUBLIC_APP_ENV,
  enableMocks: process.env.NEXT_PUBLIC_ENABLE_MOCKS,
  features: process.env.NEXT_PUBLIC_API_FEATURES,
});

export function apiMode(feature: ApiFeature): ApiMode {
  return resolveApiMode(feature, environment);
}

export function isRealApiEnabled(feature: ApiFeature): boolean {
  return apiMode(feature) === "real";
}

export const apiConfig = {
  // Browser cookies and command headers travel through the same-origin proxy.
  // An explicit override is reserved for separately hosted development APIs.
  baseUrl: (process.env.NEXT_PUBLIC_API_BASE_URL || "").replace(/\/$/, ""),
  features: environment.productionLock ? {} : environment.overrides,
};
