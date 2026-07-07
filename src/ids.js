// BATON code generation. Codes ARE the secret (no accounts), so they carry ≥128 bits.
// Crockford base32 (no I/L/O/U) — safe to read aloud / paste, case-insensitive.
import { randomBytes } from "node:crypto";

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // 32 symbols, Crockford

function base32(bytes) {
  let bits = 0, value = 0, out = "";
  for (const b of bytes) {
    value = (value << 8) | b; bits += 8;
    while (bits >= 5) { out += ALPHABET[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

// 20 bytes = 160 bits of entropy → 32 base32 chars. Grouped for legibility.
function makeSecret() {
  const s = base32(randomBytes(20));
  return s.replace(/(.{4})/g, "$1-").replace(/-$/, ""); // XXXX-XXXX-...
}

export function roomCode()    { return "BTN-R-" + makeSecret(); }
export function handoffCode() { return "BTN-H-" + makeSecret(); }

// Normalize user-typed codes: uppercase, strip spaces/hyphens, fix Crockford look-alikes.
export function normalizeCode(input) {
  return String(input || "")
    .toUpperCase().trim()
    .replace(/[\s]/g, "")
    .replace(/O/g, "0").replace(/[IL]/g, "1").replace(/U/g, "V");
}

// Server-issued participant id — distinct from the self-chosen display alias (anti-spoofing).
export function participantId() { return "p_" + base32(randomBytes(9)).toLowerCase(); }
