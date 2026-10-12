/**
 * 同源 API 运行时代理（PLAN 二、3）：浏览器统一访问 /api/v1/* → FastAPI。
 *
 * - 转发 Cookie、Origin、X-CSRF-Token 等认证相关请求头与请求体；
 * - 保留全部 Set-Cookie（登录/注册可能同时下发会话 Cookie 与注册事务 Cookie）；
 * - 认证与业务响应禁止共享缓存（Cache-Control: private, no-store）；
 * - 响应体流式透传（支持任务事件 SSE），不缓冲；
 * - 后端不可达时返回统一错误封装，不伪造成功。
 */
import { NextResponse, type NextRequest } from "next/server";

export const dynamic = "force-dynamic";

const API_INTERNAL = (process.env.API_INTERNAL_URL ?? "http://localhost:8000").replace(/\/$/, "");

const FORWARDED_REQUEST_HEADERS = [
  "cookie",
  "origin",
  "x-csrf-token",
  "content-type",
  "accept",
  "accept-language",
];

async function proxy(request: NextRequest, pathSegments: string[]) {
  const incoming = new URL(request.url);
  const target = `${API_INTERNAL}/api/v1/${pathSegments.join("/")}${incoming.search}`;

  const headers = new Headers();
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }

  let upstream: Response;
  try {
    upstream = await fetch(target, {
      method: request.method,
      headers,
      body: request.method === "GET" || request.method === "HEAD" ? undefined : await request.arrayBuffer(),
      redirect: "manual",
      cache: "no-store",
    });
  } catch {
    // 网络/后端不可达：与服务端错误区分显示（前端按 code 翻译）
    return NextResponse.json(
      {
        error: { code: "SERVICE_UNAVAILABLE", message: "The service is temporarily unavailable.", details: null },
        meta: { request_id: null },
      },
      { status: 502, headers: { "Cache-Control": "private, no-store" } },
    );
  }

  const responseHeaders = new Headers();
  upstream.headers.forEach((value, key) => {
    const lower = key.toLowerCase();
    // fetch 已解压/重建响应体，不能回传编码与长度；Set-Cookie 单独保留全部
    if (lower === "content-encoding" || lower === "content-length" || lower === "set-cookie" || lower === "transfer-encoding") {
      return;
    }
    responseHeaders.append(key, value);
  });
  for (const cookie of upstream.headers.getSetCookie()) {
    responseHeaders.append("set-cookie", cookie);
  }
  responseHeaders.set("Cache-Control", "private, no-store");

  return new Response(upstream.body, { status: upstream.status, headers: responseHeaders });
}

type RouteContext = { params: Promise<{ path: string[] }> };

export async function GET(request: NextRequest, context: RouteContext) {
  return proxy(request, (await context.params).path);
}

export async function POST(request: NextRequest, context: RouteContext) {
  return proxy(request, (await context.params).path);
}

export async function PATCH(request: NextRequest, context: RouteContext) {
  return proxy(request, (await context.params).path);
}

export async function PUT(request: NextRequest, context: RouteContext) {
  return proxy(request, (await context.params).path);
}

export async function DELETE(request: NextRequest, context: RouteContext) {
  return proxy(request, (await context.params).path);
}
