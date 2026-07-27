import { CSRF_COOKIE } from "../src/auth/csrf";
import { handleRequest } from "../src/router";
import { createEnv, createExecutionContext } from "./helpers/context";
import { FakeD1Database } from "./helpers/fake-d1";

const ORIGIN = "https://hottub.joekane.org";
const VPN_IP = "192.0.2.10";

interface Session {
  env: ReturnType<typeof createEnv>;
  database: FakeD1Database;
  token: string;
}

async function openSession(): Promise<Session> {
  const database = new FakeD1Database();
  const env = createEnv(database);
  const response = await handleRequest(
    new Request(`${ORIGIN}/api/local/session`, { headers: { "CF-Connecting-IP": VPN_IP } }),
    env,
    createExecutionContext(),
  );
  const { csrfToken } = (await response.json()) as { csrfToken: string };
  return { env, database, token: csrfToken };
}

function read(session: Session, path: string): Promise<Response> {
  return handleRequest(
    new Request(`${ORIGIN}${path}`, {
      headers: { "CF-Connecting-IP": VPN_IP, Cookie: `${CSRF_COOKIE}=${session.token}` },
    }),
    session.env,
    createExecutionContext(),
  );
}

function write(
  session: Session,
  path: string,
  body: Record<string, unknown>,
  options: { form?: boolean; token?: string; origin?: string } = {},
): Promise<Response> {
  const token = options.token ?? session.token;
  const headers = new Headers({
    "CF-Connecting-IP": VPN_IP,
    Cookie: `${CSRF_COOKIE}=${session.token}`,
    Origin: options.origin ?? ORIGIN,
  });
  let payload: string;
  if (options.form) {
    headers.set("Content-Type", "application/x-www-form-urlencoded");
    payload = new URLSearchParams(
      Object.entries({ ...body, csrf: token }).map(([key, value]) => [key, String(value)]),
    ).toString();
  } else {
    headers.set("Content-Type", "application/json");
    headers.set("X-CSRF-Token", token);
    payload = JSON.stringify(body);
  }
  return handleRequest(
    new Request(`${ORIGIN}${path}`, { method: "POST", headers, body: payload }),
    session.env,
    createExecutionContext(),
  );
}

const VIDEO = {
  providerId: "eporner",
  videoId: "fixture",
  videoUrl: "https://www.eporner.com/hd-porn/fixture/title/",
  title: "Fixture",
};

describe("local library endpoints", () => {
  it("round-trips a playlist and its items over the JSON API", async () => {
    const session = await openSession();

    const created = await write(session, "/api/local/playlists", { name: "Watch later" });
    expect(created.status).toBe(201);
    const { id } = (await created.json()) as { id: string };

    expect(
      (await write(session, "/api/local/playlists/items", { ...VIDEO, playlistId: id })).status,
    ).toBe(201);
    expect(
      (
        await write(session, "/api/local/playlists/items", {
          ...VIDEO,
          videoId: "second",
          videoUrl: "https://www.eporner.com/hd-porn/second/title/",
          playlistId: id,
        })
      ).status,
    ).toBe(201);

    const listed = await read(session, `/api/local/playlists/items?playlistId=${id}`);
    const body = (await listed.json()) as {
      playlist: { item_count: number };
      items: Array<{ video_id: string }>;
    };
    expect(body.playlist.item_count).toBe(2);
    expect(body.items.map((item) => item.video_id)).toEqual(["fixture", "second"]);

    const moved = await write(session, "/api/local/playlists/items/move", {
      playlistId: id,
      providerId: "eporner",
      videoId: "second",
      position: 0,
    });
    expect(moved.status).toBe(200);
    const reordered = (await (
      await read(session, `/api/local/playlists/items?playlistId=${id}`)
    ).json()) as { items: Array<{ video_id: string }> };
    expect(reordered.items.map((item) => item.video_id)).toEqual(["second", "fixture"]);

    expect((await write(session, "/api/local/playlists/delete", { playlistId: id })).status).toBe(
      200,
    );
    const remaining = (await (await read(session, "/api/local/playlists")).json()) as {
      items: unknown[];
    };
    expect(remaining.items).toHaveLength(0);
  });

  it("redirects form submissions back to the library page", async () => {
    const session = await openSession();
    const response = await write(
      session,
      "/api/local/playlists",
      { name: "From a form" },
      { form: true },
    );
    expect(response.status).toBe(303);
    expect(response.headers.get("Location")).toBe("/library");
    expect(session.database.playlists.size).toBe(1);
  });

  it("rejects writes without a valid CSRF token or matching origin", async () => {
    const session = await openSession();
    const badToken = await write(session, "/api/local/favourites", VIDEO, {
      token: `${session.token}x`,
    });
    expect(badToken.status).toBe(403);
    expect(await badToken.text()).toContain("invalid_csrf");

    const badOrigin = await write(session, "/api/local/favourites", VIDEO, {
      origin: "https://attacker.example",
    });
    expect(badOrigin.status).toBe(403);
    expect(await badOrigin.text()).toContain("invalid_origin");
    expect(session.database.favourites.size).toBe(0);
  });

  it("rejects a playlist item whose URL is not the provider's", async () => {
    const session = await openSession();
    const { id } = (await (
      await write(session, "/api/local/playlists", { name: "Mixed" })
    ).json()) as { id: string };
    const response = await write(session, "/api/local/playlists/items", {
      ...VIDEO,
      playlistId: id,
      videoUrl: "https://attacker.example/video",
    });
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("invalid_url");
  });

  it("reports a missing playlist rather than silently dropping the item", async () => {
    const session = await openSession();
    const response = await write(session, "/api/local/playlists/items", {
      ...VIDEO,
      playlistId: "does-not-exist",
    });
    expect(response.status).toBe(404);
    expect(await response.text()).toContain("playlist_not_found");
  });

  it("lists and unfollows creators", async () => {
    const session = await openSession();
    expect(
      (
        await write(session, "/api/local/followed-uploaders", {
          providerId: "xhamster",
          uploaderId: "xhamster:studio",
          uploaderName: "Studio",
          uploaderUrl: "https://xhamster.com/creators/studio",
        })
      ).status,
    ).toBe(201);
    const listed = (await (await read(session, "/api/local/followed-uploaders")).json()) as {
      items: Array<{ uploader_name: string }>;
    };
    expect(listed.items.map((item) => item.uploader_name)).toEqual(["Studio"]);

    expect(
      (
        await write(session, "/api/local/followed-uploaders/remove", {
          providerId: "xhamster",
          uploaderId: "xhamster:studio",
        })
      ).status,
    ).toBe(200);
    const empty = (await (await read(session, "/api/local/followed-uploaders")).json()) as {
      items: unknown[];
    };
    expect(empty.items).toHaveLength(0);
  });

  it("removes one history entry and clears the rest", async () => {
    const session = await openSession();
    await write(session, "/api/local/history", { ...VIDEO, progressSeconds: 30, duration: 120 });
    await write(session, "/api/local/history", {
      ...VIDEO,
      videoId: "second",
      videoUrl: "https://www.eporner.com/hd-porn/second/title/",
    });
    expect(
      (
        await write(session, "/api/local/history/remove", {
          providerId: "eporner",
          videoId: "second",
        })
      ).status,
    ).toBe(200);
    expect(session.database.history.size).toBe(1);
    expect((await write(session, "/api/local/history/clear", {})).status).toBe(200);
    expect(session.database.history.size).toBe(0);
  });
});

describe("library page", () => {
  it("renders stored library content for the approved address", async () => {
    const session = await openSession();
    const { id } = (await (
      await write(session, "/api/local/playlists", { name: "Watch later" })
    ).json()) as { id: string };
    await write(session, "/api/local/playlists/items", { ...VIDEO, playlistId: id });
    await write(session, "/api/local/favourites", { ...VIDEO, title: "A favourite" });
    await write(session, "/api/local/history", { ...VIDEO, duration: 200, progressSeconds: 100 });

    const response = await read(session, "/library");
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("Watch later");
    expect(html).toContain("A favourite");
    expect(html).toContain("50% watched");
    // The page must stay usable under a CSP with no script-src.
    expect(html).not.toContain("<script");
    expect(html).not.toContain("style=");
  });

  it("refuses the library page outside the VPN allowlist", async () => {
    const response = await handleRequest(
      new Request(`${ORIGIN}/library`),
      createEnv(),
      createExecutionContext(),
    );
    expect(response.status).toBe(403);
  });
});
