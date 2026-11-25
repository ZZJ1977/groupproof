"use client";

import * as React from "react";

export type GpThemeScope = "default" | "teacher";

const GpThemeScopeContext = React.createContext<GpThemeScope>("default");

export function GpThemeScopeProvider({
  scope,
  children,
}: {
  scope: GpThemeScope;
  children: React.ReactNode;
}) {
  return <GpThemeScopeContext.Provider value={scope}>{children}</GpThemeScopeContext.Provider>;
}

export function useGpThemeScope(): GpThemeScope {
  return React.useContext(GpThemeScopeContext);
}
