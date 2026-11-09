// Development twin of ./jsx-runtime.
import * as runtime from "react/jsx-dev-runtime";
import { localizeProps } from "./localize-props";

export type { JSX } from "react/jsx-dev-runtime";
export const Fragment = runtime.Fragment;
export const jsxDEV: typeof runtime.jsxDEV = (type, props, key, isStatic, source, self) =>
  runtime.jsxDEV(type, localizeProps(type, props), key, isStatic, source, self);
