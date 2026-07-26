import { csrfCookie, newCsrfToken, requireCsrf } from "../src/auth/csrf";
import { handleRequest } from "../src/router";
import { createEnv, createExecutionContext } from "./helpers/context";

describe("HTTP security", () => {
  it("sets CSP and related browser security headers", async () => {
    const response = await handleRequest(
      new Request("https://hottub.joekane.org/", {
        headers: { "CF-Connecting-IP": "192.0.2.10" },
      }),
      createEnv(),
      createExecutionContext(),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Security-Policy")).toContain("default-src 'none'");
    expect(response.headers.get("X-Frame-Options")).toBe("DENY");
    expect(response.headers.get("X-Request-Id")).toBeTruthy();
  });

  it("rejects every source route outside the VPN allowlist", async () => {
    const requests = [
      new Request("https://hottub.joekane.org/"),
      new Request("https://hottub.joekane.org/health"),
      new Request("https://hottub.joekane.org/api/status", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      }),
      new Request("https://hottub.joekane.org/not-a-route"),
    ];

    for (const request of requests) {
      const response = await handleRequest(request, createEnv(), createExecutionContext());
      expect(response.status).toBe(403);
      expect(await response.text()).toContain("admin_ip_forbidden");
    }
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

  it("protects the account portal outside the allowed VPN address", async () => {
    const response = await handleRequest(
      new Request("https://hottub.joekane.org/account"),
      createEnv(),
      createExecutionContext(),
    );
    expect(response.status).toBe(403);
    expect(await response.text()).not.toContain("stack");
  });

  it("serves the account portal from the allowed VPN address", async () => {
    const response = await handleRequest(
      new Request("https://hottub.joekane.org/account", {
        headers: { "CF-Connecting-IP": "192.0.2.10" },
      }),
      createEnv(),
      createExecutionContext(),
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Restricted to the approved VPN IP");
  });
});
