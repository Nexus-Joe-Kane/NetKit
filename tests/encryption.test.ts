import { decryptSecret, encryptSecret, primaryEncryptionKeyId } from "../src/auth/encryption";
import { bytesToBase64Url } from "../src/utils/ids";

function key(id: string): string {
  return `${id}:${bytesToBase64Url(crypto.getRandomValues(new Uint8Array(32)))}`;
}

describe("token encryption", () => {
  it("round-trips an authenticated AES-GCM value", async () => {
    const keys = key("current");
    const encrypted = await encryptSecret("access-token", keys, "user:provider");
    expect(encrypted).not.toContain("access-token");
    await expect(decryptSecret(encrypted, keys, "user:provider")).resolves.toBe("access-token");
  });

  it("supports key rotation and rejects the wrong context", async () => {
    const oldKey = key("old");
    const encrypted = await encryptSecret("refresh-token", oldKey, "user:provider");
    const rotated = `${key("new")},${oldKey}`;
    expect(primaryEncryptionKeyId(rotated)).toBe("new");
    await expect(decryptSecret(encrypted, rotated, "user:provider")).resolves.toBe("refresh-token");
    await expect(decryptSecret(encrypted, rotated, "other-user:provider")).rejects.toThrow(
      "authenticated",
    );
  });
});
