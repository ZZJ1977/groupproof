import { spawn, spawnSync } from "node:child_process";
import { cpSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

// A built server avoids Next dev's intermittent manifest races on hard reloads.
const dist = process.env.NEXT_DIST_DIR;
if (dist !== ".next-c-integration") throw new Error("Expected the isolated C integration build directory");
const build = spawnSync(process.execPath, ["node_modules/next/dist/bin/next", "build"], {
  stdio: "inherit",
  env: process.env,
});
if (build.error) throw build.error;
if (build.status !== 0) process.exit(build.status ?? 1);

const standalone = resolve(dist, "standalone");
mkdirSync(resolve(standalone, dist), { recursive: true });
cpSync(resolve(dist, "static"), resolve(standalone, dist, "static"), { recursive: true });
cpSync("public", resolve(standalone, "public"), { recursive: true });
const server = spawn(process.execPath, [resolve(standalone, "server.js")], {
  stdio: "inherit",
  env: { ...process.env, HOSTNAME: "127.0.0.1", PORT: "13007" },
});
server.on("error", (error) => { throw error; });
server.on("exit", (code) => process.exit(code ?? 1));
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => server.kill(signal));
