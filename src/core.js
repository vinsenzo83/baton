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
import { planOf, monthKey, ANON_MONTHLY } from "./plans.js";
import { codeHash } from "./crypto.js";
import { participantId } from "./ids.js";
import { CHAINS, priceUsd, verifyPayment } from "./billing-crypto.js";

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
  // Resolve the caller's plan from an API key. An UNREGISTERED key must NOT get its own
  // quota bucket (that let anyone bypass the Free limit by rotating random keys) — it's
  // treated as anonymous, sharing the single anon bucket. Only a registered account
  // (created via the billing webhook) gets its own metered bucket.
  const acct = (apiKey) => {
    if (!apiKey) return { keyHash: null, plan: "free", limits: planOf("free").limits };
    const a = store.getAccount(codeHash(apiKey));
    if (!a) return { keyHash: null, plan: "free", limits: planOf("free").limits }; // unregistered → anon
    return { keyHash: codeHash(apiKey), plan: a.plan, org: a.org || null, limits: planOf(a.plan).limits };
  };

  return {
    // ---------- ACCOUNT / BILLING (M3-3) ----------
    // View plan, limits, and current usage. Anonymous callers are Free.
    account({ api_key } = {}) {
      const a = acct(api_key);
      const period = monthKey(Date.now());
      const used = store.getUsage(a.keyHash || codeHash("anon:free"), "snapshots", period);
      const cap = a.keyHash ? a.limits.snapshotsPerMonth : ANON_MONTHLY;
      return {
        plan: a.plan, org: a.org || undefined,
        limits: { ...a.limits, snapshotsPerMonth: cap === Infinity ? "unlimited" : cap,
          activeRooms: a.limits.activeRooms === Infinity ? "unlimited" : a.limits.activeRooms },
        usage: { snapshots_this_month: used, remaining: cap === Infinity ? "unlimited" : Math.max(0, cap - used) },
        upgrade: a.plan === "free" ? "Pro $8/mo · Team $25/mo — contact to upgrade" : undefined,
      };
    },
    // ---------- CRYPTO PAYMENTS (M3-5) ----------
    // Create an invoice and return payment instructions (USDT/USDC on Tron or BSC).
    upgrade({ plan, api_key } = {}) {
      if (!["pro", "team"].includes(plan)) throw new Error("Plan must be 'pro' or 'team'.");
      if (!api_key) throw new Error("api_key is required — this key becomes your paid account. Pick a strong, private string.");
      const amount = priceUsd(plan);
      const id = "inv_" + participantId().slice(2);
      store.createInvoice(id, codeHash(api_key), plan, amount);
      const wallets = {};
      for (const [k, c] of Object.entries(CHAINS)) wallets[k] = { label: c.label, address: c.wallet() || "(not configured)", tokens: Object.keys(c.tokens) };
      return {
        invoice_id: id, plan, amount_usd: amount,
        pay_with: "USDT or USDC", wallets,
        instructions: `Send ${amount} USDT/USDC to one of the addresses above (Tron TRC-20 or BSC BEP-20), then call baton_confirm_payment with invoice_id, chain (tron|bsc), your api_key, and the tx hash.`,
        note: "Send at least the exact amount. Underpayment won't upgrade.",
      };
    },
    // Verify an on-chain payment and upgrade the plan. Async (queries the chain).
    async confirmPayment({ invoice_id, api_key, chain, tx_hash } = {}) {
      const inv = store.getInvoice(invoice_id);
      if (!inv) throw new Error("Invoice not found.");
      if (inv.status === "paid") throw new Error("Invoice already paid.");
      if (!api_key || codeHash(api_key) !== inv.key_hash) throw new Error("api_key does not match this invoice.");
      if (!tx_hash) throw new Error("tx_hash is required.");
      const v = await verifyPayment({ chain, txHash: tx_hash, minUsd: inv.amount });
      if (!v.ok) throw new Error(`Payment not verified: ${v.reason}`);
      const settled = store.settleInvoice(invoice_id, { chain, txHash: tx_hash, plan: inv.plan, keyHash: inv.key_hash });
      if (!settled.ok) throw new Error(settled.reason);
      return { ok: true, plan: inv.plan, amount_paid: v.amount, badge: `✅ Upgraded to ${inv.plan.toUpperCase()} via ${chain}` };
    },

    // Set a plan for an API key (called by the payment webhook after a successful charge).
    setPlan({ api_key, plan, org } = {}) {
      if (!api_key) throw new Error("api_key is required.");
      if (!planOf(plan) || !["free", "pro", "team"].includes(plan)) throw new Error("Unknown plan.");
      store.upsertAccount(codeHash(api_key), { plan, org });
      return { ok: true, plan };
    },
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
    pass({ snapshot, one_time = false, ttl_hours = 72, verify_manifest = null, parent_code = null, api_key = null } = {}) {
      if (!snapshot || !snapshot.context) throw new Error("snapshot.context is required (BATON Snapshot v1).");
      // M3-3: enforce the monthly snapshot quota (Free = 20/mo). Pro/Team are unlimited.
      const a = acct(api_key);
      const period = monthKey(Date.now());
      if (a.limits.snapshotsPerMonth !== Infinity) {
        const key = a.keyHash || codeHash("anon:free");
        // Registered Free account → real 20/mo gate. Anonymous shared bucket → generous ANON limit.
        const limit = a.keyHash ? a.limits.snapshotsPerMonth : ANON_MONTHLY;
        const used = store.getUsage(key, "snapshots", period);
        if (used >= limit)
          throw new Error(a.keyHash
            ? `Free plan limit reached (${limit} handoffs/month). Upgrade to Pro for unlimited.`
            : `Anonymous handoff limit reached. Sign up for a free key to get your own quota.`);
      }
      // Free plan retention caps ttl.
      if (a.plan === "free") ttl_hours = Math.min(ttl_hours, a.limits.retentionDays * 24);
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
      const { version } = store.putSnapshot(code, meta, sealed, {
        oneTime: one_time, ttlMs: ttl_hours * HOUR, verified, manifest,
        parentCode: parent_code ? normalizeCode(parent_code) : null,
      });
      // M3-3: meter the handoff against the monthly counter.
      store.bumpUsage(a.keyHash || codeHash("anon:free"), "snapshots", period);
      return {
        code, one_time, expires_in_hours: ttl_hours, secrets_redacted: redactions, version,
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

    // M3-4: diff two handoff snapshots — what changed between versions (decisions, next steps, state).
    diff({ from_code, to_code } = {}) {
      const a = store.peekSnapshot(normalizeCode(from_code));
      const b = store.peekSnapshot(normalizeCode(to_code));
      if (!a) throw new Error("from_code snapshot not found or expired.");
      if (!b) throw new Error("to_code snapshot not found or expired.");
      const listDiff = (x = [], y = [], key) => {
        const norm = (v) => key ? v?.[key] : v;
        const xs = x.map(norm), ys = y.map(norm);
        return { added: ys.filter((v) => !xs.includes(v)), removed: xs.filter((v) => !ys.includes(v)) };
      };
      const ca = a.body.context || {}, cb = b.body.context || {};
      return {
        from: { title: a.meta.title, version: a.version }, to: { title: b.meta.title, version: b.version },
        goal_changed: ca.goal !== cb.goal ? { from: ca.goal, to: cb.goal } : null,
        state_changed: ca.current_state !== cb.current_state ? { from: ca.current_state, to: cb.current_state } : null,
        decisions: listDiff(ca.decisions, cb.decisions, "what"),
        next_steps: listDiff(a.body.next_steps, b.body.next_steps, null),
        warnings: listDiff(a.body.warnings, b.body.warnings, null),
      };
    },

    revoke({ code } = {}) {
      code = normalizeCode(code);
      const ok = store.revoke(code);
      return { revoked: ok, note: ok ? "Code shredded — no longer decryptable (crypto-shred)." : "Code not found." };
    },
  };
}
