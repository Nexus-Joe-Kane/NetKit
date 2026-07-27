import { handleRequest } from "../src/router";
import { HttpError } from "../src/utils/errors";
import { requireSameOrigin } from "../src/utils/http";
import { createEnv, createExecutionContext } from "./helpers/context";

const ORIGIN = "https://hottub.joekane.org";

function check(headers: Record<string, string>): void {
  requireSameOrigin(new Request(`${ORIGIN}/account/connect`, { method: "POST", headers }), ORIGIN);
}

function rejects(headers: Record<string, string>): void {
  expect(() => check(headers)).toThrow(HttpError);
  try {
    check(headers);
  } catch (error) {
    expect((error as HttpError).code).toBe("invalid_origin");
  }
}

describe("requireSameOrigin", () => {
  it("accepts a matching Origin", () => {
    expect(() => check({ Origin: ORIGIN })).not.toThrow();
  });

  it("accepts a form post that omits Origin but reports a same-origin fetch site", () => {
    // Safari does not send Origin on same-origin form submissions. Every form
    // on this source is a plain POST, so requiring Origin locked iPhones out
    // of /account entirely.
    expect(() => check({ "Sec-Fetch-Site": "same-origin" })).not.toThrow();
  });

  it("falls back to Referer when neither Origin nor Sec-Fetch-Site is present", () => {
    expect(() => check({ Referer: `${ORIGIN}/account` })).not.toThrow();
  });

  it("rejects a cross-site Origin even when the other signals look fine", () => {
    rejects({
      Origin: "https://attacker.example",
      "Sec-Fetch-Site": "same-origin",
      Referer: `${ORIGIN}/account`,
    });
  });

  it("rejects a sandboxed 'null' Origin", () => {
    rejects({ Origin: "null" });
  });

  it("rejects a cross-site fetch even when the Referer is forged to look local", () => {
    // Sec-Fetch-Site is set by the browser and cannot be overridden by page
    // script, so it must win over a Referer an attacker controls.
    rejects({ "Sec-Fetch-Site": "cross-site", Referer: `${ORIGIN}/account` });
  });

  it("rejects a same-site-but-not-same-origin fetch", () => {
    rejects({ "Sec-Fetch-Site": "same-site" });
  });

  it("rejects a cross-origin Referer", () => {
    rejects({ Referer: "https://attacker.example/page" });
  });

  it("rejects an unparseable Referer", () => {
    rejects({ Referer: "not-a-url" });
  });

  it("rejects a request carrying none of the three signals", () => {
    rejects({});
  });
});

describe("Referrer-Policy", () => {
  it("allows a same-origin Referer so the last-resort signal exists", async () => {
    const response = await handleRequest(
      new Request(`${ORIGIN}/account`, { headers: { "CF-Connecting-IP": "92.71.54.161" } }),
      { ...createEnv(), ADMIN_ALLOWED_IPS: "92.71.54.161" },
      createExecutionContext(),
    );
    // "no-referrer" would strip the header from our own form posts too, which
    // would leave Safari builds without Sec-Fetch-Site no way to prove
    // same-site. Cross-origin requests still get no referrer under this value.
    expect(response.headers.get("Referrer-Policy")).toBe("same-origin");
  });
});
