// BATON core — transport-independent business logic. server.js wires these to MCP tools.
// Design decisions baked in from the architecture review:
//  - inbound content is fenced as untrusted data (C1) and secret-scrubbed (C4)
//  - codes carry ≥128 bits; bodies are code-sealed so the server never sees plaintext (C2/C4)
//  - one-time handoff redemption is atomic in the store (H4)
//  - VERIFIED requires observed E2E evidence, never static-only (user's hard-won lesson)
import { roomCode, handoffCode, normalizeCode } from "./ids.js";
import { fenceUntrusted, injectionFlags, scrubSecrets } from "./prompt-guard.js";
import { sealBody } from "./crypto.js";
import { gateVerdict } from "./verify.js";

const HOUR = 3600_000;
const RESERVED = /(spider|거미|baton|system|시스템|보스|boss|admin|관리자|운영|보안)/i;

// Latin look-alikes from Cyrillic/Greek — NFKC does NOT fold these, so we map them
// explicitly before the reserved-name check (else "аdmin" with Cyrillic а slips through).
const CONFUSABLE = { "а":"a","е":"e","о":"o","р":"p","с":"c","х":"x","у":"y","к":"k","ь":"b","м":"m","т":"t","н":"h",
  "і":"i","ј":"j","ѕ":"s","д":"d","л":"l","ԁ":"d","ɡ":"g","ᴀ":"a","ᴏ":"o",
  "α":"a","ο":"o","ρ":"p","ε":"e","ν":"v","κ":"k","ι":"i","ѵ":"v","ԛ":"q","ѡ":"w" };
// Display alias: NFKC + strip zero-width + collapse whitespace. Keeps real non-Latin
// names intact (e.g. Cyrillic display names are preserved).
function normalizeAlias(a) {
  return String(a ?? "")
    .normalize("NFKC")
    .replace(/[​-‍﻿]/g, "")   // zero-width
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 40);
}
// Fold Latin look-alikes to ASCII ONLY for the reserved-name test, so "аdmin" (Cyrillic а)
// is caught without mangling legitimate non-Latin display names.
function foldConfusable(a) {
  return a.toLowerCase().replace(/[^\x00-\x7f]/g, (c) => CONFUSABLE[c] || c);
}
// Reject non-numeric / out-of-range ttl so a bad value can't make a never-expiring room (L2).
function sanitizeTtl(t) {
  const n = Number(t);
  if (!Number.isFinite(n) || n <= 0) return 72;
  return Math.min(n, 24 * 90); // cap 90 days
}

export function makeCore(store) {
  return {
    // ---------- RELAY ----------
    createRoom({ name, ttl_hours = 72, alias } = {}) {
      ttl_hours = sanitizeTtl(ttl_hours);           // L2: reject non-numeric ttl (no永구방)
      if (alias != null) alias = normalizeAlias(alias);
      const code = roomCode();
      store.createRoom(code, name, ttl_hours * HOUR);
      // Creator auto-joins in one step (no separate baton_join needed).
      let member_id = null;
      if (alias) member_id = store.join(code, alias, "creator").id;
      return { code, name: name || null, expires_in_hours: ttl_hours,
        member_id, alias: alias || null,
        share: `Only sessions that know this code can join: ${code}` };
    },

    join({ code, alias, model } = {}) {
      code = normalizeCode(code);
      alias = normalizeAlias(alias);                 // M1: trim + NFKC + collapse before checks
      if (!alias) throw new Error("alias (a display name for the room) is required.");
      const room = store.getRoom(code);
      if (!room) throw new Error("Code is invalid or expired.");
      // M1: reserved-name check on the confusable-folded alias (blocks "admin ", " boss", "аdmin")
      if (RESERVED.test(foldConfusable(alias)) || store.aliasTaken(room.code_hash, alias))
        throw new Error(`Alias '${alias}' is reserved or already taken.`);
      const m = store.join(code, alias, model);
      return { member_id: m.id, alias, hint: "Use this member_id for baton_send / baton_inbox." };
    },

    send({ code, member_id, to, text } = {}) {
      code = normalizeCode(code);
      const room = store.getRoom(code);
      if (!room) throw new Error("Code is invalid or expired.");
      const me = store.members(room.code_hash).find((x) => x.id === member_id);
      if (!me) throw new Error("member_id is not in this room. Run baton_join first.");
      const { text: clean, redactions } = scrubSecrets(String(text || ""));
      const seq = store.send(code, room.code_hash, member_id, me.alias, to, clean);
      return { seq, from: me.alias, to: to || "(all)", redactions };
    },

    inbox({ code, member_id, since = 0 } = {}) {
      code = normalizeCode(code);
      const room = store.getRoom(code);
      if (!room) throw new Error("Code is invalid or expired.");
      const me = store.members(room.code_hash).find((x) => x.id === member_id);
      if (!me) throw new Error("member_id is not in this room.");
      const msgs = store.inbox(code, room.code_hash, me.alias, since);
      const flagged = msgs.map((m) => ({ ...m, injection_flags: injectionFlags(m.text) }));
      return {
        count: msgs.length,
        next_since: msgs.length ? msgs[msgs.length - 1].seq : since,
        messages_fenced: fenceUntrusted("messages", flagged),
      };
    },

    // Raw inbox for the human-facing web dashboard (no fencing — a person reads it, not an agent).
    inboxRaw({ code, member_id, since = 0 } = {}) {
      code = normalizeCode(code);
      const room = store.getRoom(code);
      if (!room) throw new Error("Code is invalid or expired.");
      const me = store.members(room.code_hash).find((x) => x.id === member_id);
      if (!me) throw new Error("member_id is not in this room.");
      const messages = store.inbox(code, room.code_hash, me.alias, since);
      return { count: messages.length, next_since: messages.length ? messages[messages.length - 1].seq : since, messages };
    },

    who({ code } = {}) {
      code = normalizeCode(code);
      const room = store.getRoom(code);
      if (!room) throw new Error("Code is invalid or expired.");
      return { members: store.members(room.code_hash) };
    },

    // ---------- HANDOFF ----------
    // The client model fills `snapshot` in the BATON Snapshot v1 shape. We scrub secrets,
    // seal under a fresh code, and (optionally) attach a verification manifest.
    pass({ snapshot, one_time = false, ttl_hours = 72, verify_manifest = null } = {}) {
      if (!snapshot || !snapshot.context) throw new Error("snapshot.context is required (BATON Snapshot v1).");
      const raw = JSON.stringify(snapshot);
      const { text: clean, redactions } = scrubSecrets(raw);
      const code = handoffCode();
      const meta = {
        title: snapshot.meta?.title || "untitled",
        author: snapshot.meta?.author || "unknown",
        source_model: snapshot.meta?.source_model || "unknown",
        project: snapshot.meta?.project || null,
      };
      // seal the (scrubbed) body under the code — server stores ciphertext only
      const sealed = sealBody(code, clean);
      // H1 fix: NEVER trust a client-supplied verdict. Recompute from the evidence server-side.
      // A manifest with verdict:"verified" but no observed E2E is downgraded to static-only.
      let manifest = null, verified = 0;
      if (verify_manifest && (verify_manifest.static_checks?.length || verify_manifest.e2e_evidence?.length)) {
        const re = gateVerdict({
          verifier: "server-recompute", target: meta.title,
          static_checks: verify_manifest.static_checks || [],
          e2e_evidence: verify_manifest.e2e_evidence || [],
        });
        manifest = re.manifest;
        verified = re.verdict === "verified" ? 1 : 0;
      }
      store.putSnapshot(code, meta, sealed, {
        oneTime: one_time, ttlMs: ttl_hours * HOUR, verified, manifest,
      });
      return {
        code, one_time, expires_in_hours: ttl_hours, secrets_redacted: redactions,
        verified: !!verified,
        badge: verified ? "🕸️ VERIFIED (includes observed E2E evidence)" : "⚪ UNVERIFIED (baton_verify not run, or static-only)",
        share: `The receiver picks it up with baton_receive: ${code}`,
      };
    },

    receive({ code } = {}) {
      code = normalizeCode(code);
      const snap = store.takeSnapshot(code);
      if (!snap) throw new Error("Handoff code is invalid, expired, or already consumed (one-time).");
      const body = JSON.parse(snap.body);
      const badge = snap.verified
        ? `🕸️ VERIFIED — passed ${snap.manifest?.method || "e2e"} evidence check`
        : "⚪ UNVERIFIED — re-verify this snapshot's claims on the receiving side (baton_verify).";
      return {
        badge, meta: snap.meta, verify_manifest: snap.manifest,
        context_fenced: fenceUntrusted("handoff snapshot", body),
        next: "Run baton_verify to re-check on the receiving side (receiver-side verification is the real trust point).",
      };
    },

    revoke({ code } = {}) {
      code = normalizeCode(code);
      const ok = store.revoke(code);
      return { revoked: ok, note: ok ? "Code shredded — no longer decryptable (crypto-shred)." : "Code not found." };
    },
  };
}
