import { verifyAdminIp, verifyAllowedSourceIp } from "../src/auth/access";
import type { Env } from "../src/config";
import { FakeD1Database } from "./helpers/fake-d1";

function createAdminEnv(allowedIps = "92.71.54.161"): Env {
  return {
    DB: new FakeD1Database() as unknown as D1Database,
    ADMIN_ALLOWED_IPS: allowedIps,
  };
}

describe("source-IP verification", () => {
  it("applies the same exact IP check to the whole source", () => {
    const request = new Request("https://hottub.joekane.org/api/status", {
      headers: { "CF-Connecting-IP": "92.71.54.161" },
    });

    expect(verifyAllowedSourceIp(request, createAdminEnv())).toBe("92.71.54.161");
    expect(() =>
      verifyAllowedSourceIp(
        new Request("https://hottub.joekane.org/api/status", {
          headers: { "CF-Connecting-IP": "203.0.113.20" },
        }),
        createAdminEnv(),
      ),
    ).toThrow("restricted");
  });

  it("accepts the configured VPN egress IP", async () => {
    const request = new Request("https://hottub.joekane.org/account", {
      headers: { "CF-Connecting-IP": "92.71.54.161" },
    });

    const identity = await verifyAdminIp(request, createAdminEnv());

    expect(identity.sourceIp).toBe("92.71.54.161");
    expect(identity.subject).toBe("92.71.54.161");
    expect(identity.userKey).toHaveLength(43);
  });

  it("supports an intentional comma-separated allowlist", async () => {
    const request = new Request("https://hottub.joekane.org/account", {
      headers: { "CF-Connecting-IP": "2001:db8::10" },
    });

    const identity = await verifyAdminIp(request, createAdminEnv("92.71.54.161, 2001:db8::10"));

    expect(identity.sourceIp).toBe("2001:db8::10");
  });

  it("rejects a missing or different source IP", async () => {
    await expect(
      verifyAdminIp(new Request("https://hottub.joekane.org/account"), createAdminEnv()),
    ).rejects.toMatchObject({ status: 403, code: "admin_ip_forbidden" });

    const request = new Request("https://hottub.joekane.org/account", {
      headers: { "CF-Connecting-IP": "203.0.113.20" },
    });
    await expect(verifyAdminIp(request, createAdminEnv())).rejects.toMatchObject({
      status: 403,
      code: "admin_ip_forbidden",
    });
  });

  it("fails closed when the allowlist is empty", async () => {
    const request = new Request("https://hottub.joekane.org/account", {
      headers: { "CF-Connecting-IP": "92.71.54.161" },
    });

    await expect(verifyAdminIp(request, createAdminEnv("  "))).rejects.toMatchObject({
      status: 503,
      code: "admin_ip_not_configured",
    });
  });
});
