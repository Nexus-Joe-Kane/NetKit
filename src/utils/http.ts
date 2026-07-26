import { ZodError, type ZodType } from "zod";
import { HttpError } from "./errors";

const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

function securityHeaders(contentType = ""): Headers {
  const headers = new Headers({
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
  });
  if (contentType.includes("text/html")) {
    headers.set(
      "Content-Security-Policy",
      "default-src 'none'; base-uri 'none'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; img-src 'self' https: data:; style-src 'self'",
    );
  } else {
    headers.set("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
  }
  return headers;
}

export function applySecurityHeaders(response: Response, requestId: string): Response {
  const headers = new Headers(response.headers);
  const defaults = securityHeaders(headers.get("content-type") ?? "");
  for (const [key, value] of defaults) {
    if (!headers.has(key)) headers.set(key, value);
  }
  headers.set("X-Request-Id", requestId);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export function jsonResponse(
  value: unknown,
  status = 200,
  extraHeaders: HeadersInit = {},
): Response {
  const body = JSON.stringify(value);
  if (new TextEncoder().encode(body).byteLength > MAX_RESPONSE_BYTES) {
    throw new HttpError(502, "Response exceeded the configured size limit.", "response_too_large");
  }
  const headers = new Headers(extraHeaders);
  headers.set("Content-Type", "application/json; charset=utf-8");
  if (!headers.has("Cache-Control")) headers.set("Cache-Control", "no-store");
  return new Response(body, { status, headers });
}

export function htmlResponse(html: string, status = 200, extraHeaders: HeadersInit = {}): Response {
  const headers = new Headers(extraHeaders);
  headers.set("Content-Type", "text/html; charset=utf-8");
  if (!headers.has("Cache-Control")) headers.set("Cache-Control", "no-store");
  return new Response(html, { status, headers });
}

export function cssResponse(css: string): Response {
  return new Response(css, {
    headers: {
      "Cache-Control": "public, max-age=86400",
      "Content-Type": "text/css; charset=utf-8",
    },
  });
}

async function readLimitedBody(request: Request): Promise<string> {
  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > MAX_REQUEST_BYTES) {
    throw new HttpError(413, "Request body is too large.", "request_too_large");
  }
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_REQUEST_BYTES) {
      await reader.cancel();
      throw new HttpError(413, "Request body is too large.", "request_too_large");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

function parseUrlEncoded(text: string): Record<string, string | string[]> {
  const parsed: Record<string, string | string[]> = {};
  for (const [key, value] of new URLSearchParams(text)) {
    const current = parsed[key];
    if (current === undefined) parsed[key] = value;
    else if (Array.isArray(current)) current.push(value);
    else parsed[key] = [current, value];
  }
  return parsed;
}

export async function parseBody<T>(request: Request, schema: ZodType<T>): Promise<T> {
  const contentType = (request.headers.get("content-type") ?? "application/json")
    .split(";")[0]
    ?.trim()
    .toLowerCase();
  if (
    contentType !== "application/json" &&
    contentType !== "text/plain" &&
    contentType !== "application/x-www-form-urlencoded"
  ) {
    throw new HttpError(415, "Unsupported request content type.", "unsupported_media_type");
  }

  const text = await readLimitedBody(request);
  let value: unknown = {};
  if (text.trim()) {
    try {
      value =
        contentType === "application/x-www-form-urlencoded"
          ? parseUrlEncoded(text)
          : JSON.parse(text);
    } catch {
      throw new HttpError(400, "Request body is not valid JSON.", "invalid_json");
    }
  }

  const result = schema.safeParse(value);
  if (!result.success) {
    const issue = result.error.issues[0];
    throw new HttpError(
      400,
      issue ? `${issue.path.join(".") || "body"}: ${issue.message}` : "Invalid request body.",
      "invalid_request",
    );
  }
  return result.data;
}

export function errorResponse(error: unknown, requestId: string): Response {
  if (error instanceof HttpError) {
    return jsonResponse(
      { error: { code: error.code, message: error.message, requestId } },
      error.status,
    );
  }
  if (error instanceof ZodError) {
    return jsonResponse(
      {
        error: {
          code: "invalid_output",
          message: "The generated response did not satisfy the API contract.",
          requestId,
        },
      },
      502,
    );
  }
  return jsonResponse(
    {
      error: {
        code: "internal_error",
        message: "The request could not be completed.",
        requestId,
      },
    },
    500,
  );
}

export function getClientIp(request: Request): string {
  return (
    request.headers.get("CF-Connecting-IP") ??
    request.headers.get("X-Real-IP") ??
    "unknown"
  ).slice(0, 80);
}

export function requireSameOrigin(request: Request, expectedOrigin: string): void {
  const origin = request.headers.get("Origin");
  if (!origin || origin !== expectedOrigin) {
    throw new HttpError(403, "Origin validation failed.", "invalid_origin");
  }
}
