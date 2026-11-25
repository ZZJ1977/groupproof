import { NextResponse, type NextRequest } from "next/server";
import { ADMIN_ENVIRONMENT_COOKIE, normalizeAdminEnvironment } from "@/admin/lib/admin-environment";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  let body: { environment?: string } = {};
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ code: "VALIDATION_ERROR" }, { status: 400 });
  }
  const environment = normalizeAdminEnvironment(body.environment);
  if (body.environment !== "develop" && body.environment !== "main") {
    return NextResponse.json({ code: "VALIDATION_ERROR" }, { status: 400 });
  }
  const response = NextResponse.json({ environment });
  response.cookies.set(ADMIN_ENVIRONMENT_COOKIE, environment, {
    path: "/",
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 60 * 60 * 24 * 30,
  });
  return response;
}
