import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";

const MAGIC = "XAGG1";

/** AES-256-GCM with a scrypt-derived key. Output: MAGIC.salt.iv.tag.ciphertext (base64url). */
export function encrypt(plaintext: string, passphrase: string): string {
  if (!passphrase || passphrase.length < 16) throw new Error("XERO_AGG_TOKEN_KEY must be at least 16 characters");
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = scryptSync(passphrase, salt, 32, { N: 16384, r: 8, p: 1 });
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return [MAGIC, salt, iv, cipher.getAuthTag(), ct].map((x) => (typeof x === "string" ? x : x.toString("base64url"))).join(".");
}

export function decrypt(blob: string, passphrase: string): string {
  const [magic, salt, iv, tag, ct] = blob.trim().split(".");
  if (magic !== MAGIC || !ct) throw new Error("Token file is not in the expected encrypted format");
  const key = scryptSync(passphrase, Buffer.from(salt, "base64url"), 32, { N: 16384, r: 8, p: 1 });
  const d = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
  d.setAuthTag(Buffer.from(tag, "base64url"));
  try {
    return Buffer.concat([d.update(Buffer.from(ct, "base64url")), d.final()]).toString("utf8");
  } catch {
    throw new Error("Could not decrypt token file: wrong XERO_AGG_TOKEN_KEY or the file was tampered with");
  }
}
