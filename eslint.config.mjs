import { FlatCompat } from "@eslint/eslintrc";

const compat = new FlatCompat({ baseDirectory: import.meta.dirname });

const config = [{ ignores: [".next/**", ".next-dev/**", ".next-e2e/**", "node_modules/**", "server/**"] }, ...compat.extends("next/core-web-vitals")];

export default config;
