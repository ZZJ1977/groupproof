import { NextResponse, type NextRequest } from "next/server";
import { normalizeLocale } from "@/i18n/config";

/** 服务端写入显式语言 Cookie（gp_locale）：仅白名单值、Path=/、SameSite=Lax、生产 Secure；不是身份凭证。 */
export async function POST(request: NextRequest) {
  let body: { locale?: string } = {};
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ code: "VALIDATION_ERROR" }, { status: 400 });
  }
  const locale = normalizeLocale(body.locale);
  if (!locale) {
    return NextResponse.json({ code: "VALIDATION_ERROR" }, { status: 400 });
  }
  const response = NextResponse.json({ locale });
  response.cookies.set("gp_locale", locale, {
    path: "/",
    sameSite: "lax",
    secure: process.env.APP_MODE === "real",
    maxAge: 60 * 60 * 24 * 365,
  });
  return response;
}
