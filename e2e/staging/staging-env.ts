import { statSync } from "node:fs";

export function stagingUuid(name: string): string {
  const value = process.env[name]?.trim();
  if (!value || !/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(value)) {
    throw new Error(`Set ${name} to a UUID in the isolated staging project.`);
  }
  return value.toLowerCase();
}

export default function requireStagingSession() {
  const path = process.env.C5_STAGING_STORAGE_STATE;
  if (!path || !statSync(path, { throwIfNoEntry: false })?.isFile()) {
    throw new Error("Set C5_STAGING_STORAGE_STATE to a Playwright storage-state file for a signed-in staging user.");
  }
}
