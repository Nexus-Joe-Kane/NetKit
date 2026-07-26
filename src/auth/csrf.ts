import { HttpError } from "../utils/errors";
import { bytesToBase64Url } from "../utils/ids";

export const CSRF_COOKIE = "__Host-hottub_csrf";

function parseCookies(request: Request): Map<string, string> {
  const cookies = new Map<string, string>();
  for (const part of (request.headers.get("Cookie") ?? "").split(";")) {
    const separator = part.indexOf("=");
    if (separator <= 0) continue;
    cookies.set(part.slice(0, separator).trim(), part.slice(separator + 1).trim());
  }
  return cookies;
}

export function newCsrfToken(): string {
  return bytesToBase64Url(crypto.getRandomValues(new Uint8Array(32)));
}

export function csrfCookie(token: string): string {
  return `${CSRF_COOKIE}=${token}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=3600`;
}

function constantTimeEqual(left: string, right: string): boolean {
  const encoder = new TextEncoder();
  const leftBytes = encoder.encode(left);
  const rightBytes = encoder.encode(right);
  let difference = leftBytes.byteLength ^ rightBytes.byteLength;
  const length = Math.max(leftBytes.byteLength, rightBytes.byteLength);
  for (let index = 0; index < length; index += 1) {
    difference |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }
  return difference === 0;
}

export function requireCsrf(request: Request, submittedToken: string): void {
  const cookieToken = parseCookies(request).get(CSRF_COOKIE);
  if (
    !cookieToken ||
    submittedToken.length < 32 ||
    !constantTimeEqual(cookieToken, submittedToken)
  ) {
    throw new HttpError(403, "CSRF validation failed.", "invalid_csrf");
  }
}
