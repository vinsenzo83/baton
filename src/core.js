// BATON core — transport-independent business logic. server.js wires these to MCP tools.
// Design decisions baked in from the architecture review:
//  - inbound content is fenced as untrusted data (C1) and secret-scrubbed (C4)
//  - codes carry ≥128 bits; bodies are code-sealed so the server never sees plaintext (C2/C4)
//  - one-time handoff redemption is atomic in the store (H4)
//  - VERIFIED requires observed E2E evidence, never static-only (user's hard-won lesson)
import { roomCode, handoffCode, normalizeCode } from "./ids.js";
import { fenceUntrusted, injectionFlags, scrubSecrets } from "./prompt-guard.js";
import { sealBody } from "./crypto.js";
import { gateVerdict, issueReceipt, verifyReceipt, tierOf, badgeFor } from "./verify.js";
import { planOf, monthKey, anonMonthly, isBillingOn } from "./plans.js";
import { codeHash } from "./crypto.js";
import { participantId } from "./ids.js";
import { paymentOptions, priceUsd, verifyPayment } from "./billing-crypto.js";

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
    .replace(/['"<>`\\]/g, "")     // 🟡 XSS: strip quote/bracket/backtick/backslash (dash onclick handler)
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

  // member_id → { room_id, alias, approved } for team rooms. After join, activity is keyed by
  // member_id (the invite code is just a rotating entry ticket, not needed to send/read).
  const ctx = (memberId) => {
    const m = store.memberRoom(memberId);
    if (!m) throw new Error("member_id not found — join with a valid invite code first.");
    return m;
  };
  // Owner check: the api_key's hash must match the room's owner_hash.
  const ownerOf = (roomId, apiKey) => {
    const room = store.getTeamRoom(roomId);
    if (!room) throw new Error("room_id not found.");
    if (!apiKey || codeHash(apiKey) !== room.owner_hash) throw new Error("Only the room owner can do this.");
    return room;
  };
  const ownerKey = (apiKey) => {
    if (!apiKey || String(apiKey).length < 12) throw new Error("api_key (12+ characters) is required for private operations data.");
    return codeHash(String(apiKey));
  };

  return {
    // ---------- SIGNUP (funnel) ----------
    // Self-serve free account. Creates a personal Free bucket (20/mo). No email/payment.
    // Returns an api_key the user saves and attaches (Authorization: Bearer, or api_key arg).
    signup({ api_key } = {}) {
      let key;
      if (api_key !== undefined && api_key !== null && api_key !== "") {
        if (String(api_key).length < 12) throw new Error("api_key must be at least 12 characters (or omit it to auto-generate a strong one).");
        key = String(api_key);
      } else {
        key = "btn_" + roomCode().replace(/^BTN-R-/, "").replace(/-/g, "").toLowerCase();
      }
      store.upsertAccount(codeHash(key), { plan: "free" });
      return {
        api_key: key, plan: "free", handoffs_per_month: planOf("free").limits.snapshotsPerMonth,
        how_to_use: "Save this key privately. Add it to your MCP client once — `claude mcp add --transport http baton <url>/mcp --header \"Authorization: Bearer " + key + "\"` — or pass api_key to baton_pass. Then upgrade anytime with baton_upgrade.",
        note: "This key IS your account. Anyone with it uses your quota — keep it secret.",
      };
    },

    // ---------- ACCOUNT / BILLING (M3-3) ----------
    // View plan, limits, and current usage. Anonymous callers are Free.
    account({ api_key } = {}) {
      const a = acct(api_key);
      const period = monthKey(Date.now());
      const used = store.getUsage(a.keyHash || codeHash("anon:free"), "snapshots", period);
      const cap = a.keyHash ? a.limits.snapshotsPerMonth : anonMonthly();
      return {
        plan: a.plan, org: a.org || undefined,
        limits: { ...a.limits, snapshotsPerMonth: cap === Infinity ? "unlimited" : cap,
          activeRooms: a.limits.activeRooms === Infinity ? "unlimited" : a.limits.activeRooms,
          seats_per_room: a.limits.seatsPerRoom },
        usage: { snapshots_this_month: used, remaining: cap === Infinity ? "unlimited" : Math.max(0, cap - used) },
        upgrade: a.plan === "free" ? "Run baton_upgrade to go Pro ($8/mo, unlimited handoffs) or Team ($25/mo)." : undefined,
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
      const options = paymentOptions(); // [{id:"USDT:tron", token, chain, network, address}, …]
      return {
        invoice_id: id, plan, amount_usd: amount,
        pay_options: options.length ? options : "(no wallet configured yet)",
        instructions: `Send exactly ${amount} of the chosen token (USDT or USDC) to its matching address above. ⚠️ Use the address for your EXACT token+network — a wrong combo can be lost. Then call baton_confirm_payment with invoice_id, token (USDT|USDC), chain (tron|bsc), your api_key, and the tx hash.`,
        note: "Underpayment won't upgrade. Send from a wallet you control.",
      };
    },
    // Verify an on-chain payment and upgrade the plan. Async (queries the chain).
    async confirmPayment({ invoice_id, api_key, token, chain, tx_hash } = {}) {
      const inv = store.getInvoice(invoice_id);
      if (!inv) throw new Error("Invoice not found.");
      if (inv.status === "paid") throw new Error("Invoice already paid.");
      if (!api_key || codeHash(api_key) !== inv.key_hash) throw new Error("api_key does not match this invoice.");
      if (!tx_hash) throw new Error("tx_hash is required.");
      if (!["USDT", "USDC"].includes(token)) throw new Error("token must be USDT or USDC.");
      const v = await verifyPayment({ token, chain, txHash: tx_hash, minUsd: inv.amount });
      if (!v.ok) throw new Error(`Payment not verified: ${v.reason}`);
      const settled = store.settleInvoice(invoice_id, { chain, txHash: tx_hash, plan: inv.plan, keyHash: inv.key_hash, token, actualAmount: v.amount });
      if (!settled.ok) throw new Error(settled.reason);
      return { ok: true, plan: inv.plan, amount_paid: v.amount, badge: `✅ Upgraded to ${inv.plan.toUpperCase()} — paid ${v.amount} ${token} on ${chain}` };
    },

    // Set a plan for an API key (called by the payment webhook after a successful charge).
    setPlan({ api_key, plan, org } = {}) {
      if (!api_key) throw new Error("api_key is required.");
      if (!planOf(plan) || !["free", "pro", "team"].includes(plan)) throw new Error("Unknown plan.");
      store.upsertAccount(codeHash(api_key), { plan, org });
      return { ok: true, plan };
    },
    // ---------- TEAM ROOMS (persistent room + rotating invite codes) ----------
    // The room lives on (owner-managed); people enter via invite codes that expire (72h) and can
    // be re-issued. To add someone new, issue a fresh invite (baton_new_invite) and share it.
    createRoom({ name, alias, api_key, require_approval = false } = {}) {
      if (alias != null) alias = normalizeAlias(alias);
      // Owner identity = the api_key itself (no signup needed): owner_hash = codeHash(api_key).
      const ownerHash = api_key ? codeHash(api_key) : null;
      const room_id = roomCode();                       // stable internal id (owner keeps this)
      store.createTeamRoom(room_id, name || "", ownerHash, !!require_approval);
      const invite = roomCode();                        // first invite code (shared, 72h)
      store.addInvite(codeHash(invite), room_id, 72 * HOUR);
      let member_id = null;
      if (alias) {
        if (RESERVED.test(foldConfusable(alias))) throw new Error(`Alias '${alias}' is reserved.`);
        member_id = store.teamJoin(room_id, alias, "creator", true).id;   // owner is auto-approved
      }
      return {
        room_id, invite_code: invite, invite_expires_in_hours: 72,
        member_id, alias: alias || null, require_approval: !!require_approval,
        share: `Share this invite code (valid 72h): ${invite}. Reissue anytime with baton_new_invite.`,
        owner_note: "Keep room_id + your api_key to manage the room (new invite / approve / kick).",
      };
    },

    // Owner issues a fresh invite code (72h). Optionally revoke all older codes.
    newInvite({ room_id, api_key, revoke_old = false } = {}) {
      ownerOf(room_id, api_key);
      if (revoke_old) store.revokeInvitesForRoom(room_id);
      const invite = roomCode();
      store.addInvite(codeHash(invite), room_id, 72 * HOUR);
      return { invite_code: invite, expires_in_hours: 72, revoked_old_codes: !!revoke_old };
    },

    join({ code, alias, model } = {}) {
      code = normalizeCode(code);
      alias = normalizeAlias(alias);
      if (!alias) throw new Error("alias (a display name for the room) is required.");
      const room_id = store.resolveInvite(codeHash(code));
      if (!room_id) throw new Error("Invite code is invalid, expired, or revoked. Ask the owner for a fresh code.");
      if (RESERVED.test(foldConfusable(alias)) || store.aliasTaken(room_id, alias))
        throw new Error(`Alias '${alias}' is reserved or already taken.`);
      const room = store.getTeamRoom(room_id);
      const approved = !room.require_approval;
      const m = store.teamJoin(room_id, alias, model, approved);
      return { member_id: m.id, alias, approved,
        hint: approved
          ? "You're in. Use this member_id for baton_send / baton_inbox."
          : "Waiting for the owner to approve you — ask them to run baton_approve." };
    },

    send({ member_id, to, text } = {}) {
      const me = ctx(member_id);
      if (!me.approved) throw new Error("You're not approved into the room yet.");
      const { text: clean, redactions } = scrubSecrets(String(text || ""));
      const seq = store.send(me.room_id, member_id, me.alias, to, clean);
      return { seq, from: me.alias, to: to || "(all)", redactions };
    },

    inbox({ member_id, since = 0 } = {}) {
      const me = ctx(member_id);
      if (!me.approved) throw new Error("You're not approved into the room yet.");   // 🟠 read gate
      store.touchMember(member_id);
      const msgs = store.inbox(me.room_id, me.alias, since);
      const flagged = msgs.map((m) => ({ ...m, injection_flags: injectionFlags(m.text) }));
      return {
        count: msgs.length,
        next_since: msgs.length ? msgs[msgs.length - 1].seq : since,
        messages_fenced: fenceUntrusted("messages", flagged),
      };
    },

    // Raw inbox for the human-facing web dashboard (no fencing — a person reads it, not an agent).
    inboxRaw({ member_id, since = 0 } = {}) {
      const me = ctx(member_id);
      if (!me.approved) throw new Error("You're not approved into the room yet.");   // 🟠 read gate
      store.touchMember(member_id);
      const messages = store.inbox(me.room_id, me.alias, since);
      return { count: messages.length, next_since: messages.length ? messages[messages.length - 1].seq : since, messages };
    },

    who({ member_id, room_id, api_key } = {}) {
      const rid = room_id || (member_id ? ctx(member_id).room_id : null);
      if (!rid) throw new Error("member_id or room_id is required.");
      if (room_id) { ownerOf(room_id, api_key); return { members: store.members(rid) }; }  // owner: full (ids for kick/approve)
      const me = ctx(member_id);
      if (!me.approved) throw new Error("You're not approved into the room yet.");
      // 🔴 member view: strip member ids — a participant must NOT learn others' bearer ids
      // (that would let them read others' DMs, impersonate, or kick via leave).
      return { members: store.members(rid).map(({ id, ...pub }) => pub) };
    },

    // Leave a room — frees the seat immediately.
    leave({ member_id } = {}) {
      const m = store.memberRoom(member_id);
      if (!m) return { left: false };
      return { left: store.leaveMember(m.room_id, member_id) };
    },

    // Owner removes a participant.
    kick({ room_id, api_key, target_member_id } = {}) {
      ownerOf(room_id, api_key);
      return { removed: store.leaveMember(room_id, target_member_id) };
    },

    // Owner approves a pending participant (when require_approval is on).
    approve({ room_id, api_key, member_id } = {}) {
      ownerOf(room_id, api_key);
      return { approved: store.approveMember(room_id, member_id) };
    },

    // ---------- OPERATIONS: TASK GRAPH / GIT EVIDENCE / COST ----------
    taskCreate({ api_key, title, room_id = null, assignee = null, depends_on = [] } = {}) {
      const owner = ownerKey(api_key);
      if (!title?.trim()) throw new Error("title is required.");
      if (room_id) ownerOf(room_id, api_key);
      for (const dep of depends_on || []) if (!store.getTask(owner, dep)) throw new Error(`dependency task not found: ${dep}`);
      const id = "tsk_" + participantId().slice(2);
      const task = store.createTask({ id, owner_hash: owner, room_id, title: title.trim().slice(0, 240), assignee });
      for (const dep of depends_on || []) store.addTaskEdge(owner, dep, id, "blocks");
      return { task, depends_on };
    },
    taskLink({ api_key, from_task_id, to_task_id, edge_type = "blocks" } = {}) {
      const owner = ownerKey(api_key);
      if (!store.getTask(owner, from_task_id) || !store.getTask(owner, to_task_id)) throw new Error("both tasks must exist and belong to this account.");
      if (from_task_id === to_task_id) throw new Error("a task cannot depend on itself.");
      if (!["blocks","relates","supersedes"].includes(edge_type)) throw new Error("edge_type must be blocks, relates, or supersedes.");
      if (edge_type === "blocks") {
        const g = store.taskGraph(owner); const next = new Map();
        for (const e of g.edges.filter((e) => e.edge_type === "blocks")) (next.get(e.from_task_id) || next.set(e.from_task_id, []).get(e.from_task_id)).push(e.to_task_id);
        const seen = new Set(); const walk = (n) => n === from_task_id || (!seen.has(n) && (seen.add(n), (next.get(n) || []).some(walk)));
        if (walk(to_task_id)) throw new Error("edge would create a task cycle.");
      }
      store.addTaskEdge(owner, from_task_id, to_task_id, edge_type);
      return { linked: true, from_task_id, to_task_id, edge_type };
    },
    taskUpdate({ api_key, task_id, status } = {}) {
      const owner = ownerKey(api_key);
      if (!["todo","running","blocked","done","cancelled"].includes(status)) throw new Error("invalid task status.");
      if (!store.getTask(owner, task_id)) throw new Error("task not found.");
      return { task: store.updateTask(owner, task_id, status) };
    },
    taskGraph({ api_key } = {}) { return store.taskGraph(ownerKey(api_key)); },
    gitRecord({ api_key, task_id = null, repository, commit_sha, branch = null, diff_sha256 = null, test_command = null, test_exit_code = null, artifact_refs = [] } = {}) {
      const owner = ownerKey(api_key);
      if (task_id && !store.getTask(owner, task_id)) throw new Error("task not found.");
      if (!repository?.trim()) throw new Error("repository is required.");
      if (!/^[a-f0-9]{7,64}$/i.test(commit_sha || "")) throw new Error("commit_sha must be a 7-64 character hex Git SHA.");
      if (diff_sha256 && !/^[a-f0-9]{64}$/i.test(diff_sha256)) throw new Error("diff_sha256 must be 64 hex characters.");
      if (!Array.isArray(artifact_refs) || artifact_refs.length > 50) throw new Error("artifact_refs must be an array of at most 50 items.");
      const id = "git_" + participantId().slice(2);
      return { evidence: store.addGitEvidence({ id, owner_hash: owner, task_id, repository: repository.trim(), commit_sha, branch, diff_sha256, test_command, test_exit_code, artifact_refs }) };
    },
    gitEvidence({ api_key, task_id = null } = {}) { return { evidence: store.gitEvidence(ownerKey(api_key), task_id) }; },
    costRecord({ api_key, task_id = null, provider, model = null, input_tokens = 0, output_tokens = 0, amount_usd, source = "reported", idempotency_key } = {}) {
      const owner = ownerKey(api_key);
      if (task_id && !store.getTask(owner, task_id)) throw new Error("task not found.");
      if (!provider?.trim() || !idempotency_key?.trim()) throw new Error("provider and idempotency_key are required.");
      const amount = Number(amount_usd);
      if (!Number.isFinite(amount) || amount < 0 || amount > 1_000_000) throw new Error("amount_usd is invalid.");
      const cleanInt = (v) => Number.isSafeInteger(Number(v)) && Number(v) >= 0 ? Number(v) : null;
      const input = cleanInt(input_tokens), output = cleanInt(output_tokens);
      if (input == null || output == null) throw new Error("token counts must be non-negative integers.");
      const id = "cst_" + participantId().slice(2);
      return { ...store.addCostEvent({ id, owner_hash: owner, task_id, provider: provider.trim(), model, input_tokens: input, output_tokens: output, amount_usd: amount, source, idempotency_key: idempotency_key.trim() }), id };
    },
    costSummary({ api_key } = {}) { return store.costSummary(ownerKey(api_key)); },

    // ---------- HANDOFF ----------
    // The client model fills `snapshot` in the BATON Snapshot v1 shape. We scrub secrets,
    // seal under a fresh code, and (optionally) attach a verification manifest.
    pass({ snapshot, one_time = false, ttl_hours = 72, verify = null, verify_manifest = null, receipt = null, parent_code = null, api_key = null, room = null, member_id = null } = {}) {
      if (!snapshot || !snapshot.context) throw new Error("snapshot.context is required (BATON Snapshot v1).");
      // M3-3: enforce the monthly snapshot quota (Free = 20/mo). Pro/Team are unlimited.
      const a = acct(api_key);
      const period = monthKey(Date.now());
      if (isBillingOn() && a.limits.snapshotsPerMonth !== Infinity) {
        const key = a.keyHash || codeHash("anon:free");
        // Registered Free account → real 20/mo gate. Anonymous shared bucket → generous ANON limit.
        const limit = a.keyHash ? a.limits.snapshotsPerMonth : anonMonthly();
        const used = store.getUsage(key, "snapshots", period);
        if (used >= limit)
          throw new Error(a.keyHash
            ? `Free plan limit reached (${limit} handoffs/month). Run baton_upgrade for Pro (unlimited, $8/mo).`
            : `Free trial limit reached (${limit}/month). Run baton_signup for a free account (${planOf("free").limits.snapshotsPerMonth}/mo), or baton_upgrade for Pro (unlimited).`);
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
      // Trust comes from a SERVER-SIGNED receipt (the differentiator): a signed receipt whose
      // verdict is "verified" is trusted because only the server could have signed it.
      let manifest = null, verified = 0;
      const producerHash = a.keyHash || null;
      // Convenience (dogfood UX): pass evidence inline → mint+sign the receipt here. This is the
      // PRODUCER verifying their own work, so it is ALWAYS self-attested — the verifier identity
      // is forced to the producer's, so it can never masquerade as independent (C1 fix).
      if (!receipt && verify && (verify.static_checks?.length || verify.e2e_evidence?.length)) {
        receipt = issueReceipt({
          verifier: verify.verifier || "self-attested", verifier_key_hash: producerHash,
          target: meta.title, capsule: code,
          environment: verify.environment, static_checks: verify.static_checks || [],
          e2e_evidence: verify.e2e_evidence || [], artifacts: verify.artifacts || [], issued_at: Date.now(),
        });
      }
      if (receipt) {
        const chk = verifyReceipt(receipt);
        if (chk.valid) {
          verified = receipt.verdict === "verified" ? 1 : 0;
          // TIER decided by IDENTITY here, not by any client-supplied string (C1 fix):
          const tier = tierOf(receipt.verifier_key_hash, producerHash);
          const independent = tier === "independent";
          manifest = { ...receipt, tier, badge: badgeFor(receipt.verdict, independent) };
        }
        // invalid signature → treated as unverified (forged receipts never earn the badge)
      } else if (verify_manifest && (verify_manifest.static_checks?.length || verify_manifest.e2e_evidence?.length)) {
        // Legacy path: recompute server-side from raw evidence (H1). Never trust a raw verdict.
        const re = gateVerdict({
          verifier: "server-recompute", target: meta.title,
          static_checks: verify_manifest.static_checks || [],
          e2e_evidence: verify_manifest.e2e_evidence || [],
        });
        // Legacy raw evidence from the producer → self-attested (never independent).
        manifest = { ...re.manifest, tier: "self-attested", badge: badgeFor(re.verdict, false) };
        verified = re.verdict === "verified" ? 1 : 0;
      }
      const { version } = store.putSnapshot(code, meta, sealed, {
        oneTime: one_time, ttlMs: ttl_hours * HOUR, verified, manifest,
        parentCode: parent_code ? normalizeCode(parent_code) : null,
      });
      // M3-3: meter the handoff against the monthly counter.
      store.bumpUsage(a.keyHash || codeHash("anon:free"), "snapshots", period);
      const badge = manifest?.badge || (verified ? "🕸️ VERIFIED" : "⚪ UNVERIFIED (attach `verify` evidence or a receipt)");
      // Auto-deliver: if a room + member_id are given, drop the code into that room so the
      // receiving session sees it in baton_inbox — no human copies the code around (dogfood fix).
      let delivered_to = null;
      if (member_id) {   // if the sender is in a room, drop the handoff code into it (member_id → room)
        try {
          const m = store.memberRoom(member_id);
          if (m && m.approved) {
            store.send(m.room_id, member_id, m.alias, null,
              `🏃 New baton: ${code}  ${badge} — receive with baton_receive`);
            store.addRoomHandoff(m.room_id, code);   // remember for "consolidate this room"
            delivered_to = m.room_id;
          }
        } catch { /* best-effort; the code is still returned below */ }
      }
      return {
        code, one_time, expires_in_hours: ttl_hours, secrets_redacted: redactions, version,
        verified: !!verified, badge,
        verify_reason: manifest?.reason,      // WHY (e.g. why it's only static-only)
        tier: manifest?.tier,                 // self-attested | independent
        delivered_to,                         // room the code was auto-sent to (if any)
        share: delivered_to
          ? `Auto-sent to your room — the others find it in baton_inbox (no copy-paste).`
          : `The receiver picks it up with baton_receive: ${code}`,
      };
    },

    receive({ code } = {}) {
      code = normalizeCode(code);
      const snap = store.takeSnapshot(code);
      if (!snap) throw new Error("Handoff code is invalid, expired, or already consumed (one-time).");
      const body = JSON.parse(snap.body);
      const m = snap.manifest;
      const isReceipt = m && m.kind === "baton.verification-receipt/v1";
      const obs = isReceipt ? (m.observed || []).filter((o) => o.observed).length : 0;
      const badge = m && m.badge
        ? (isReceipt ? `${m.badge} — by ${m.verifier} (${m.tier}), ${obs}/${(m.observed || []).length} observed` : m.badge)
        : "⚪ UNVERIFIED — verify on YOUR side (baton_verify) before trusting this work.";
      return {
        badge, meta: snap.meta,
        receipt: isReceipt ? m : undefined,               // signed, inspectable trust record
        verify_reason: isReceipt ? m.reason : undefined,  // WHY this verdict (transparency)
        verify_manifest: isReceipt ? undefined : m,
        context_fenced: fenceUntrusted("handoff snapshot", body),
        next: m && m.tier === "self-attested"
          ? "This is the producer's own attestation (🔏 SEALED). The real trust point is re-verifying on YOUR machine (baton_verify) — an independent receipt earns 🕸️ VERIFIED."
          : "Receipts are server-signed and can't be forged. Re-verify on your side if the stakes are high.",
      };
    },

    // ---------- VERIFICATION RECEIPT (the differentiator) ----------
    // An INDEPENDENT verifier (not the producer) replays the work and gets a server-SIGNED
    // receipt. Attach it to baton_pass so the receiver trusts observed evidence, not a claim.
    verify({ target, capsule, environment, static_checks, e2e_evidence, artifacts, verifier, api_key } = {}) {
      // Bind the verifier to a registered identity. "independent" is decided later by comparing
      // this hash to the producer's — a free-string verifier name can NOT earn 🕸️ (C1 fix).
      const a = acct(api_key);
      return issueReceipt({
        verifier: verifier || "receiver-spider", verifier_key_hash: a.keyHash || null,
        target, capsule, environment,
        static_checks: static_checks || [], e2e_evidence: e2e_evidence || [],
        artifacts: artifacts || [], issued_at: Date.now(),
      });
    },

    // ---------- CONSOLIDATE (결과 도출) ----------
    // Gather several departments' handoffs into ONE result board a HUMAN reads and judges.
    // Not AI-automatic: it surfaces each dept's work + its verification tier so a person can
    // see at a glance what's independently verified vs only self-attested vs unverified.
    consolidate({ codes = [], room_id, api_key } = {}) {
      // Room mode: owner consolidates every handoff that flowed through their room (no manual codes).
      if (room_id) { ownerOf(room_id, api_key); codes = store.roomHandoffCodes(room_id); }
      if (!Array.isArray(codes) || codes.length === 0) throw new Error(room_id ? "No handoffs in this room yet — pass a baton into it first." : "codes[] is required (the handoff codes to consolidate).");
      // C2 DoS fix: each code costs a scrypt (decrypt). Cap the count and DEDUPE so repeating one
      // code can't amplify CPU. 50 is plenty for a human decision board.
      if (codes.length > 50) throw new Error("Too many codes (max 50 per board).");
      const uniq = [...new Set(codes.map((c) => normalizeCode(c)))];
      const departments = uniq.map((code) => {
        try {
          const snap = store.peekSnapshot(code);
          if (!snap) return { code, error: "invalid, expired, or consumed (one-time)" };
          const m = snap.manifest;
          const isReceipt = m && m.kind === "baton.verification-receipt/v1";
          const ctx = snap.body?.context || {};
          return {
            code, title: snap.meta?.title || "untitled", author: snap.meta?.author || "unknown",
            model: snap.meta?.source_model || null,
            goal: ctx.goal || null, current_state: ctx.current_state || null,
            next_steps: snap.body?.next_steps || [],
            verified: !!snap.verified,
            tier: m?.tier || (snap.verified ? "self-attested" : null),
            verifier: isReceipt ? m.verifier : null,
            badge: m?.badge || (snap.verified ? "🔏 SEALED" : "⚪ UNVERIFIED"),
            reason: m?.reason || null,
          };
        } catch { return { code, error: "unreadable (corrupt or wrong key)" }; }  // Minor: per-item guard
      });
      const ok = departments.filter((d) => !d.error);
      const independent = ok.filter((d) => d.verified && d.tier === "independent").length;
      const selfAtt = ok.filter((d) => d.verified && d.tier === "self-attested").length;
      const unver = ok.filter((d) => !d.verified).length;
      const failed = departments.filter((d) => d.error).length;
      return {
        summary: `${ok.length} handoff(s) · ${independent} independently verified · ${selfAtt} self-attested · ${unver} unverified${failed ? ` · ${failed} unreadable` : ""}`,
        trust: unver > 0 || selfAtt > 0
          ? "⚠️ Not all results are independently verified — cross-verify the 🔏/⚪ items before finalizing (the producer grading their own work isn't trust)."
          : independent === ok.length && ok.length > 0
            ? "✅ Every result was independently verified — safe to finalize."
            : "No verified results yet.",
        departments,
        open_next_steps: ok.flatMap((d) => d.next_steps),
        note: "This is a decision board for a human — review the evidence, don't rubber-stamp.",
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

    revoke({ code } = {}) {   // handoff (snapshot) shred
      code = normalizeCode(code);
      const ok = store.revoke(code);
      return { revoked: ok, note: ok ? "Handoff code shredded — no longer decryptable (crypto-shred)." : "Code not found." };
    },

    // Owner closes the whole team room (shreds it + invites + members + messages).
    closeRoom({ room_id, api_key } = {}) {
      ownerOf(room_id, api_key);
      return { closed: store.deleteRoom(room_id) };
    },
  };
}
