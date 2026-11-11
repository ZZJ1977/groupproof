import { expect, type Page } from "@playwright/test";

// The signed destination is intercepted. Only fixture bytes can be sent during this suite.
export async function storageRoutes(page: Page, scope: "project" | "course", scopeId: string) {
  const receipt = "00000000-0000-0000-0000-000000000899";
  const signed = `https://fixture.invalid/storage/v1/object/upload/sign/files/${scope}/${scopeId}/${receipt}/spec.txt?token=fixture`;
  const bytes = Buffer.from("file version content");
  const payload = { name: "spec.txt", mimeType: "text/plain", buffer: bytes };
  const stage = { issued: 0, put: 0, checked: 0, reject: false, denyCompletion: false };
  await page.route("**/api/v1/storage/uploads", (route) => {
    expect(route.request().headers()["x-csrf-token"]).toBeTruthy();
    expect(route.request().postDataJSON()).toEqual({ scope, scope_id: scopeId, filename: payload.name,
      mime_type: payload.mimeType, size_bytes: bytes.length });
    stage.issued++;
    return route.fulfill({ json: { data: { receipt_id: receipt, method: "PUT", upload_url: signed,
      expires_at: new Date(Date.now() + 300_000).toISOString() }, meta: { request_id: "upload-test" } } });
  });
  await page.route(signed, (route) => {
    const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "PUT",
      "Access-Control-Allow-Headers": "content-type" };
    if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
    expect(route.request().method()).toBe("PUT");
    expect(route.request().headers()["x-csrf-token"]).toBeUndefined();
    expect(route.request().headers()["authorization"]).toBeUndefined();
    expect(route.request().postDataBuffer()).toEqual(bytes);
    stage.put++;
    return route.fulfill({ status: 200, headers: cors, body: "{}" });
  });
  await page.route("**/api/v1/storage/uploads/" + receipt + "/complete", (route) => {
    expect(route.request().headers()["x-csrf-token"]).toBeTruthy();
    stage.checked++;
    if (stage.denyCompletion) return route.fulfill({ status: 403, json: {
      error: { code: "PROJECT_MEMBER_REQUIRED", message: "权限已变化。" }, meta: { request_id: "upload-test" },
    } });
    if (stage.reject) return route.fulfill({ status: 422, json: {
      error: { code: "UPLOAD_REJECTED", message: "文件未通过检查。" }, meta: { request_id: "upload-test" },
    } });
    return route.fulfill({ json: { data: { receipt_id: receipt, status: "completed", scope, scope_id: scopeId,
      content_hash: "a".repeat(64), filename: payload.name, size_bytes: bytes.length, mime_type: payload.mimeType },
    meta: { request_id: "upload-test" } } });
  });
  return { payload, stage, receipt };
}
