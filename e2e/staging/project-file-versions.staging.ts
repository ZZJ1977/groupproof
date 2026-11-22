import { test } from "@playwright/test";
import { verifyProjectFileVersions } from "./project-file-scenario";
import { stagingUuid } from "./staging-env";

test("C5-02: upload two versions, interrupt a third, and read back both originals", async ({ page }) => {
  await verifyProjectFileVersions(page, stagingUuid("C5_STAGING_PROJECT_ID"));
});
