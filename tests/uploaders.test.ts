import { handleRequest } from "../src/router";
import { createEnv, createExecutionContext, post } from "./helpers/context";

describe("POST /api/uploaders", () => {
  it("returns the documented 404 for an unsupported provider profile", async () => {
    const response = await handleRequest(
      post("/api/uploaders", {
        channel: "eporner",
        uploaderId: "fixture-studio",
        profileContent: true,
      }),
      createEnv(),
      createExecutionContext(),
    );
    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("uploader_not_supported");
  });

  it("rejects a request without an uploader identifier", async () => {
    const response = await handleRequest(
      post("/api/uploaders", { channel: "eporner" }),
      createEnv(),
      createExecutionContext(),
    );
    expect(response.status).toBe(400);
  });
});
