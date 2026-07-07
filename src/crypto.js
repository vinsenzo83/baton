// BATON — code-derived encryption.
// The invite/handoff CODE is the only secret. We store ciphertext + code_hash only,
// never the code or plaintext. Even the server operator cannot read a body without the code.
import { randomBytes, scryptSync, createCipheriv, createDecipheriv, createHash, timingSafeEqual } from "node:crypto";

const SCRYPT_N = 1 << 15; // 32768 — CPU/mem hard enough for a per-request KDF

// Derive a 256-bit key from the code + per-record salt.
export function deriveKey(code, salt) {
  return scryptSync(code, salt, 32, { N: SCRYPT_N, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
}

// sha256(code) — lets us look a record up by code without storing the code.
export function codeHash(code) {
  return createHash("sha256").update(code, "utf8").digest("hex");
}

// Encrypt a UTF-8 string body under the code. Returns all fields needed to decrypt later.
export function sealBody(code, plaintext) {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = deriveKey(code, salt);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    salt: salt.toString("base64"),
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    ct: ct.toString("base64"),
  };
}

// Decrypt. Throws if the code is wrong (GCM auth failure) — that's the access check.
export function openBody(code, sealed) {
  const key = deriveKey(code, Buffer.from(sealed.salt, "base64"));
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(sealed.iv, "base64"));
  decipher.setAuthTag(Buffer.from(sealed.tag, "base64"));
  const pt = Buffer.concat([decipher.update(Buffer.from(sealed.ct, "base64")), decipher.final()]);
  return pt.toString("utf8");
}

// Constant-time hash compare for code_hash lookups.
export function hashEquals(a, b) {
  const ba = Buffer.from(a, "hex");
  const bb = Buffer.from(b, "hex");
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}
