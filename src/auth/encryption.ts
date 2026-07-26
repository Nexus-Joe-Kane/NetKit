import { base64UrlToBytes, bytesToBase64Url } from "../utils/ids";

interface EncryptionKey {
  id: string;
  key: CryptoKey;
}

function parseEntries(value: string): Array<{ id: string; bytes: Uint8Array<ArrayBuffer> }> {
  const entries = value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const separator = entry.indexOf(":");
      if (separator <= 0) throw new Error("Encryption keys must use key_id:base64url format.");
      const id = entry.slice(0, separator);
      const bytes = base64UrlToBytes(entry.slice(separator + 1));
      if (!/^[a-zA-Z0-9._-]{1,64}$/u.test(id)) throw new Error("Invalid encryption key ID.");
      if (bytes.byteLength !== 32) throw new Error("Encryption keys must contain 32 bytes.");
      return { id, bytes };
    });
  if (entries.length === 0) throw new Error("At least one encryption key is required.");
  if (new Set(entries.map((entry) => entry.id)).size !== entries.length) {
    throw new Error("Encryption key IDs must be unique.");
  }
  return entries;
}

async function loadKeys(value: string): Promise<EncryptionKey[]> {
  return Promise.all(
    parseEntries(value).map(async ({ id, bytes }) => ({
      id,
      key: await crypto.subtle.importKey("raw", bytes, { name: "AES-GCM" }, false, [
        "encrypt",
        "decrypt",
      ]),
    })),
  );
}

function additionalData(context: string): Uint8Array<ArrayBuffer> {
  return new Uint8Array(new TextEncoder().encode(`unified-hottub-source:${context}`));
}

export async function encryptSecret(
  plaintext: string,
  configuredKeys: string,
  context: string,
): Promise<string> {
  const [primary] = await loadKeys(configuredKeys);
  if (!primary) throw new Error("No encryption key is configured.");
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: additionalData(context), tagLength: 128 },
    primary.key,
    new TextEncoder().encode(plaintext),
  );
  return [
    "v1",
    primary.id,
    bytesToBase64Url(iv),
    bytesToBase64Url(new Uint8Array(ciphertext)),
  ].join(".");
}

export async function decryptSecret(
  payload: string,
  configuredKeys: string,
  context: string,
): Promise<string> {
  const [version, keyId, encodedIv, encodedCiphertext, ...rest] = payload.split(".");
  if (version !== "v1" || !keyId || !encodedIv || !encodedCiphertext || rest.length > 0) {
    throw new Error("Encrypted secret has an unsupported format.");
  }
  const keys = await loadKeys(configuredKeys);
  const selected = keys.find((candidate) => candidate.id === keyId);
  if (!selected) throw new Error("The encryption key is not available.");
  const iv = base64UrlToBytes(encodedIv);
  if (iv.byteLength !== 12) throw new Error("Encrypted secret has an invalid IV.");
  try {
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv, additionalData: additionalData(context), tagLength: 128 },
      selected.key,
      base64UrlToBytes(encodedCiphertext),
    );
    return new TextDecoder().decode(plaintext);
  } catch {
    throw new Error("Encrypted secret could not be authenticated.");
  }
}

export function primaryEncryptionKeyId(configuredKeys: string): string {
  const primary = parseEntries(configuredKeys)[0];
  if (!primary) throw new Error("No encryption key is configured.");
  return primary.id;
}
