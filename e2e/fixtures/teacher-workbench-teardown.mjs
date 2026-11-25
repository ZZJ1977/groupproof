import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export default async function globalTeardown() {
  const tsconfigPath = path.resolve(process.cwd(), "tsconfig.json");
  if (existsSync(tsconfigPath)) {
    const raw = readFileSync(tsconfigPath, "utf8");
    if (/\.next-teacher-workbench(?:-real)?\//.test(raw)) {
      const cleaned = raw
        .replace(/^\s*"\.next-teacher-workbench(?:-real)?\/[^"]+",?\r?\n/gm, "")
        .replace(/,(\s*\])/g, "$1");
      if (cleaned !== raw) {
        writeFileSync(tsconfigPath, cleaned, "utf8");
      }
    }
  }

  const nextEnvPath = path.resolve(process.cwd(), "next-env.d.ts");
  if (existsSync(nextEnvPath)) {
    const nextEnvRaw = readFileSync(nextEnvPath, "utf8");
    const resetNextEnv = nextEnvRaw.replace(
      /\.\/\.next-teacher-workbench(?:-real)?\/types\/routes\.d\.ts/g,
      "./.next/types/routes.d.ts",
    );
    if (resetNextEnv !== nextEnvRaw) {
      writeFileSync(nextEnvPath, resetNextEnv, "utf8");
    }
  }
}
