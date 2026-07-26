import { handleRequest } from "../src/router";
import { UploaderSchema } from "../src/hottub/schemas";
import { epornerFixture } from "./fixtures/eporner";
import { upstreamFetch } from "./fixtures/upstream";
import { createEnv, createExecutionContext, post } from "./helpers/context";

describe("POST /api/uploaders", () => {
  it("returns an Eporner creator profile with optional public videos", async () => {
    const fetcher = vi.fn(async () => {
      return new Response(JSON.stringify(epornerFixture), {
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;
    const response = await handleRequest(
      post("/api/uploaders", {
        channel: "eporner",
        uploaderId: "fixture-studio",
        uploaderName: "Fixture Studio",
        profileContent: true,
      }),
      createEnv(),
      createExecutionContext(),
      fetcher,
    );
    expect(response.status).toBe(200);
    const body = UploaderSchema.parse(await response.json());
    expect(body.name).toBe("Fixture Studio");
    expect(body.videos).toHaveLength(1);
    expect(body.url).toContain("eporner.com/profile/");
  });

  it("routes an uploader ID prefix to its federated provider", async () => {
    const response = await handleRequest(
      post("/api/uploaders", {
        uploaderId: "xvideos:fixture-creator",
        uploaderName: "Fixture Creator",
        profileContent: true,
      }),
      createEnv(),
      createExecutionContext(),
      upstreamFetch(),
    );
    expect(response.status).toBe(200);
    const body = UploaderSchema.parse(await response.json());
    expect(body.channel).toBe("xvideos");
    expect(body.videos).toHaveLength(1);
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
