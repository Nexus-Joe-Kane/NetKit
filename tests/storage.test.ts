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
});
