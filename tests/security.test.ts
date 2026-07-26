import { csrfCookie, newCsrfToken, requireCsrf } from "../src/auth/csrf";
import { handleRequest } from "../src/router";
import { createEnv, createExecutionContext } from "./helpers/context";

describe("HTTP security", () => {
  it("sets CSP and related browser security headers", async () => {
    const response = await handleRequest(
      new Request("https://hottub.joekane.org/"),
      createEnv(),
      createExecutionContext(),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Security-Policy")).toContain("default-src 'none'");
    expect(response.headers.get("X-Frame-Options")).toBe("DENY");
    expect(response.headers.get("X-Request-Id")).toBeTruthy();
  });

  it("requires a matching double-submit CSRF token", () => {
    const token = newCsrfToken();
    const cookie = csrfCookie(token).split(";")[0];
    const request = new Request("https://hottub.joekane.org/account/disconnect", {
      headers: { Cookie: cookie ?? "" },
    });
    expect(() => requireCsrf(request, token)).not.toThrow();
    expect(() => requireCsrf(request, `${token}x`)).toThrow("CSRF");
  });

  it("protects the account portal when Access is not configured", async () => {
    const response = await handleRequest(
      new Request("https://hottub.joekane.org/account"),
      createEnv(),
      createExecutionContext(),
    );
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("stack");
  });
});
