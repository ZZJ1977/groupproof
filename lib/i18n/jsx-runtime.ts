// JSX runtime used by the whole app (tsconfig "jsxImportSource": "@/lib/i18n").
// It is React's runtime plus localizeProps(), so Chinese UI text renders in the active language.
import * as runtime from "react/jsx-runtime";
import { localizeProps } from "./localize-props";

export type { JSX } from "react/jsx-runtime";
export const Fragment = runtime.Fragment;
export const jsx: typeof runtime.jsx = (type, props, key) => runtime.jsx(type, localizeProps(type, props), key);
export const jsxs: typeof runtime.jsxs = (type, props, key) => runtime.jsxs(type, localizeProps(type, props), key);
