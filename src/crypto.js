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

// Seal/open with an ALREADY-DERIVED key — lets a room derive its key once and reuse it
// across many messages, instead of running scrypt per message (DoS fix). iv is per-message.
export function sealWithKey(key, plaintext) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return { iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), ct: ct.toString("base64") };
}
export function openWithKey(key, sealed) {
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(sealed.iv, "base64"));
  decipher.setAuthTag(Buffer.from(sealed.tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(sealed.ct, "base64")), decipher.final()]).toString("utf8");
}

// Verification receipts are signed by the SERVER so no client can forge a "verified" claim.
// The signature covers the canonical receipt body; anyone can verify it, nobody can fake it.
import { createHmac } from "node:crypto";
const RECEIPT_SECRET = () => process.env.BATON_RECEIPT_SECRET || "baton-dev-receipt-secret-change-me";
// Stable stringify (sorted keys) so the signature is deterministic.
function canonical(obj) {
  if (obj === null || typeof obj !== "object") return JSON.stringify(obj);
  if (Array.isArray(obj)) return "[" + obj.map(canonical).join(",") + "]";
  return "{" + Object.keys(obj).sort().map((k) => JSON.stringify(k) + ":" + canonical(obj[k])).join(",") + "}";
}
export function signReceipt(body) {
  return createHmac("sha256", RECEIPT_SECRET()).update(canonical(body)).digest("hex");
}
export function verifyReceiptSig(body, signature) {
  const expect = signReceipt(body);
  return typeof signature === "string" && signature.length === expect.length && hashEquals(expect, signature);
}

// Constant-time hash compare for code_hash lookups.
export function hashEquals(a, b) {
  const ba = Buffer.from(a, "hex");
  const bb = Buffer.from(b, "hex");
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}
