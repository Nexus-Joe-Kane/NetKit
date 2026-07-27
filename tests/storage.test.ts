import { ConnectionRepository } from "../src/storage/connections";
import { LocalLibraryRepository } from "../src/storage/library";
import { bytesToBase64Url } from "../src/utils/ids";
import { FakeD1Database } from "./helpers/fake-d1";

describe("D1 repositories", () => {
  it("encrypts provider token material and can disconnect it", async () => {
    const database = new FakeD1Database();
    const repository = new ConnectionRepository(database as unknown as D1Database);
    const keys = `current:${bytesToBase64Url(crypto.getRandomValues(new Uint8Array(32)))}`;
    await repository.save({
      userKey: "user",
      providerId: "future-provider",
      accessToken: "secret-access",
      refreshToken: "secret-refresh",
      capabilities: { history: true },
      encryptionKeys: keys,
    });
    const raw = database.connections.get("user:future-provider");
    expect(raw?.encrypted_access_token).not.toContain("secret-access");

    const stored = await repository.get("user", "future-provider", keys);
    expect(stored?.accessToken).toBe("secret-access");
    expect(stored?.refreshToken).toBe("secret-refresh");
    expect(stored?.summary.capabilities).toEqual({ history: true });
    await expect(repository.disconnect("user", "future-provider")).resolves.toBe(true);
  });

  it("stores local history and favourites separately", async () => {
    const database = new FakeD1Database();
    const repository = new LocalLibraryRepository(database as unknown as D1Database);
    const video = {
      providerId: "eporner",
      videoId: "fixture",
      videoUrl: "https://www.eporner.com/hd-porn/fixture/title/",
      title: "Fixture",
      duration: 100,
    };
    await repository.recordHistory("user", { ...video, progressSeconds: 25 });
    await repository.addFavourite("user", video);
    expect(await repository.listHistory("user")).toHaveLength(1);
    expect(await repository.listFavourites("user")).toHaveLength(1);
    await expect(repository.removeFavourite("user", "eporner", "fixture")).resolves.toBe(true);
  });

  it("removes a single history entry and clears the rest", async () => {
    const database = new FakeD1Database();
    const repository = new LocalLibraryRepository(database as unknown as D1Database);
    for (const videoId of ["one", "two", "three"]) {
      await repository.recordHistory("user", {
        providerId: "eporner",
        videoId,
        videoUrl: `https://www.eporner.com/hd-porn/${videoId}/title/`,
        title: videoId,
      });
    }
    await expect(repository.removeHistoryEntry("user", "eporner", "two")).resolves.toBe(true);
    await expect(repository.removeHistoryEntry("user", "eporner", "two")).resolves.toBe(false);
    expect(await repository.listHistory("user")).toHaveLength(2);
    await expect(repository.clearHistory("user")).resolves.toBe(2);
    expect(await repository.listHistory("user")).toHaveLength(0);
  });

  it("manages playlists and keeps item positions dense", async () => {
    const database = new FakeD1Database();
    const repository = new LocalLibraryRepository(database as unknown as D1Database);
    const playlistId = await repository.createPlaylist("user", "Watch later", "Saved for later");

    const [first] = await repository.listPlaylists("user");
    expect(first?.name).toBe("Watch later");
    expect(first?.item_count).toBe(0);

    for (const videoId of ["a", "b", "c"]) {
      await expect(
        repository.addPlaylistItem("user", playlistId, {
          providerId: "eporner",
          videoId,
          videoUrl: `https://www.eporner.com/hd-porn/${videoId}/title/`,
          title: videoId.toUpperCase(),
        }),
      ).resolves.toBe(true);
    }
    expect(
      (await repository.listPlaylistItems("user", playlistId)).map((row) => row.video_id),
    ).toEqual(["a", "b", "c"]);

    await expect(repository.movePlaylistItem("user", playlistId, "eporner", "c", 0)).resolves.toBe(
      true,
    );
    expect(
      (await repository.listPlaylistItems("user", playlistId)).map((row) => row.video_id),
    ).toEqual(["c", "a", "b"]);

    // A move past the end clamps to the last slot rather than leaving a gap.
    await expect(repository.movePlaylistItem("user", playlistId, "eporner", "c", 99)).resolves.toBe(
      true,
    );
    const afterClamp = await repository.listPlaylistItems("user", playlistId);
    expect(afterClamp.map((row) => row.video_id)).toEqual(["a", "b", "c"]);
    expect(afterClamp.map((row) => row.position)).toEqual([0, 1, 2]);

    await expect(repository.removePlaylistItem("user", playlistId, "eporner", "a")).resolves.toBe(
      true,
    );
    const afterRemove = await repository.listPlaylistItems("user", playlistId);
    expect(afterRemove.map((row) => row.video_id)).toEqual(["b", "c"]);
    expect(afterRemove.map((row) => row.position)).toEqual([0, 1]);

    await expect(repository.updatePlaylist("user", playlistId, { name: "Queue" })).resolves.toBe(
      true,
    );
    expect((await repository.getPlaylist("user", playlistId))?.name).toBe("Queue");

    await expect(repository.deletePlaylist("user", playlistId)).resolves.toBe(true);
    expect(await repository.listPlaylists("user")).toHaveLength(0);
    expect(await repository.listPlaylistItems("user", playlistId)).toHaveLength(0);
  });

  it("refuses playlist work that belongs to another user key", async () => {
    const database = new FakeD1Database();
    const repository = new LocalLibraryRepository(database as unknown as D1Database);
    const playlistId = await repository.createPlaylist("owner", "Private");

    await expect(
      repository.addPlaylistItem("intruder", playlistId, {
        providerId: "eporner",
        videoId: "a",
        videoUrl: "https://www.eporner.com/hd-porn/a/title/",
        title: "A",
      }),
    ).resolves.toBe(false);
    await expect(repository.getPlaylist("intruder", playlistId)).resolves.toBeNull();
    await expect(repository.updatePlaylist("intruder", playlistId, { name: "x" })).resolves.toBe(
      false,
    );
    await expect(repository.deletePlaylist("intruder", playlistId)).resolves.toBe(false);
    expect(await repository.listPlaylists("owner")).toHaveLength(1);
  });

  it("lists and unfollows creators", async () => {
    const database = new FakeD1Database();
    const repository = new LocalLibraryRepository(database as unknown as D1Database);
    await repository.followUploader("user", {
      providerId: "xhamster",
      uploaderId: "xhamster:studio",
      uploaderName: "Studio",
      uploaderUrl: "https://xhamster.com/creators/studio",
    });
    const followed = await repository.listFollowedUploaders("user");
    expect(followed).toHaveLength(1);
    expect(followed[0]?.uploader_name).toBe("Studio");
    await expect(repository.unfollowUploader("user", "xhamster", "xhamster:studio")).resolves.toBe(
      true,
    );
    expect(await repository.listFollowedUploaders("user")).toHaveLength(0);
  });
});
