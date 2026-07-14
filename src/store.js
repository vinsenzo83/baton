// BATON storage. SQLite for MVP/self-host; the interface is narrow so a Postgres
// adapter can drop in for the hosted service (arch review M1). Bodies are sealed with
// code-derived keys — the DB never holds plaintext or the code itself (C4).
import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { sealBody, openBody, codeHash, deriveKey, sealWithKey, openWithKey } from "./crypto.js";
import { participantId } from "./ids.js";

export function openStore(path = "./data/baton.db") {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS rooms (
      code_hash TEXT PRIMARY KEY, name TEXT, salt TEXT, iv TEXT, tag TEXT, ct TEXT,
      created_at INTEGER, expires_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS members (
      id TEXT PRIMARY KEY, room_hash TEXT, alias TEXT, model TEXT, joined_at INTEGER, last_seen INTEGER
    );
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT, room_hash TEXT, seq INTEGER,
      from_id TEXT, from_alias TEXT, to_alias TEXT,
      salt TEXT, iv TEXT, tag TEXT, ct TEXT, created_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS snapshots (
      code_hash TEXT PRIMARY KEY, title TEXT, author TEXT, source_model TEXT, project TEXT,
      salt TEXT, iv TEXT, tag TEXT, ct TEXT,
      verified INTEGER DEFAULT 0, verify_manifest TEXT,
      one_time INTEGER DEFAULT 0, consumed INTEGER DEFAULT 0,
      created_at INTEGER, expires_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_msg_room ON messages(room_hash, seq);
    CREATE INDEX IF NOT EXISTS idx_mem_room ON members(room_hash);

    -- TEAM ROOMS: a room persists (rooms.code_hash = stable room_id, owner-managed); people
    -- enter via rotating INVITE codes that expire (72h) and can be re-issued. Server-managed
    -- (not code-derived) so invites can rotate and the owner can kick/approve.
    CREATE TABLE IF NOT EXISTS invites (
      invite_hash TEXT PRIMARY KEY, room_id TEXT, expires_at INTEGER, revoked INTEGER DEFAULT 0, created_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_invite_room ON invites(room_id);
    -- handoffs that flowed through a room (auto-delivered) → owner can consolidate the whole room.
    CREATE TABLE IF NOT EXISTS room_handoffs (
      room_id TEXT, code TEXT, created_at INTEGER, PRIMARY KEY(room_id, code)
    );

    -- shared spider corpus (M2-2). Only scrubbed, generalized techniques — never code/secrets.
    CREATE TABLE IF NOT EXISTS spider_patterns (
      fingerprint TEXT PRIMARY KEY, klass TEXT, name TEXT, signal TEXT, fix TEXT,
      tags TEXT, severity TEXT DEFAULT 'yellow', tier TEXT DEFAULT 'mid',
      hit_count INTEGER DEFAULT 1, contributor_count INTEGER DEFAULT 1,
      verified INTEGER DEFAULT 0, created_at INTEGER, updated_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS spider_contributions (
      fingerprint TEXT, contributor_hash TEXT, ip_hash TEXT, created_at INTEGER,
      UNIQUE(fingerprint, contributor_hash)
    );

    -- M3-3: accounts + usage metering (payment integration is external).
    CREATE TABLE IF NOT EXISTS accounts (
      key_hash TEXT PRIMARY KEY, plan TEXT DEFAULT 'free', email_hash TEXT,
      org TEXT, created_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS usage_counters (
      key_hash TEXT, kind TEXT, period TEXT, count INTEGER DEFAULT 0,
      UNIQUE(key_hash, kind, period)
    );

    -- M3-5: crypto payment invoices + spent tx hashes (replay protection).
    CREATE TABLE IF NOT EXISTS invoices (
      id TEXT PRIMARY KEY, key_hash TEXT, plan TEXT, amount REAL,
      status TEXT DEFAULT 'pending', chain TEXT, tx_hash TEXT, created_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS used_txs (
      tx_hash TEXT PRIMARY KEY, chain TEXT, invoice_id TEXT, created_at INTEGER
    );

    -- Operations layer: task DAG, Git-bound evidence, and append-only cost ledger.
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY, owner_hash TEXT NOT NULL, room_id TEXT, title TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'todo', assignee TEXT, created_at INTEGER, updated_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS task_edges (
      owner_hash TEXT NOT NULL, from_task_id TEXT NOT NULL, to_task_id TEXT NOT NULL,
      edge_type TEXT NOT NULL, created_at INTEGER,
      PRIMARY KEY(owner_hash,from_task_id,to_task_id,edge_type)
    );
    CREATE TABLE IF NOT EXISTS git_evidence (
      id TEXT PRIMARY KEY, owner_hash TEXT NOT NULL, task_id TEXT, repository TEXT NOT NULL,
      commit_sha TEXT NOT NULL, branch TEXT, diff_sha256 TEXT, test_command TEXT,
      test_exit_code INTEGER, artifact_refs TEXT, recorded_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS cost_events (
      id TEXT PRIMARY KEY, owner_hash TEXT NOT NULL, task_id TEXT, provider TEXT NOT NULL,
      model TEXT, input_tokens INTEGER DEFAULT 0, output_tokens INTEGER DEFAULT 0,
      amount_usd REAL NOT NULL, source TEXT NOT NULL, idempotency_key TEXT NOT NULL,
      occurred_at INTEGER, UNIQUE(owner_hash,idempotency_key)
    );
    CREATE INDEX IF NOT EXISTS idx_tasks_owner ON tasks(owner_hash,updated_at);
    CREATE INDEX IF NOT EXISTS idx_cost_owner ON cost_events(owner_hash,occurred_at);
  `);

  // Additive migration: older corpus tables predate ip_hash (verified-forgery defense).
  try { db.exec(`ALTER TABLE spider_contributions ADD COLUMN ip_hash TEXT`); } catch { /* already present */ }
  // M3-4: snapshot versioning — link a handoff to its parent + version number.
  try { db.exec(`ALTER TABLE snapshots ADD COLUMN parent_hash TEXT`); } catch { /* present */ }
  try { db.exec(`ALTER TABLE snapshots ADD COLUMN version INTEGER DEFAULT 1`); } catch { /* present */ }
  // M3-5/6: record which token + actual on-chain amount settled an invoice (for admin revenue).
  try { db.exec(`ALTER TABLE invoices ADD COLUMN token TEXT`); } catch { /* present */ }
  try { db.exec(`ALTER TABLE invoices ADD COLUMN actual_amount REAL`); } catch { /* present */ }
  // B (seats): tag rooms with an owner so the active-room limit can be enforced per account.
  try { db.exec(`ALTER TABLE rooms ADD COLUMN owner_hash TEXT`); } catch { /* present */ }
  // TEAM ROOMS migrations: plaintext room name (server-managed), approval flag, member approval.
  try { db.exec(`ALTER TABLE rooms ADD COLUMN room_name TEXT`); } catch { /* present */ }
  try { db.exec(`ALTER TABLE rooms ADD COLUMN require_approval INTEGER DEFAULT 0`); } catch { /* present */ }
  try { db.exec(`ALTER TABLE members ADD COLUMN approved INTEGER DEFAULT 1`); } catch { /* present */ }
  try { db.exec(`ALTER TABLE messages ADD COLUMN body TEXT`); } catch { /* present */ }
  // C1: purge any corpus rows containing HTML/angle-brackets (stored-XSS cleanup, idempotent).
  try { db.exec(`DELETE FROM spider_patterns WHERE name LIKE '%<%' OR name LIKE '%>%'
                 OR signal LIKE '%<%' OR fix LIKE '%<%' OR klass LIKE '%<%'`); } catch { /* table may not exist yet */ }

  const now = () => Date.now();
  const alive = (row) => row && (!row.expires_at || row.expires_at > now());

  return {
    // ---- TEAM ROOMS (persistent; room_id = rooms.code_hash) ----
    createTeamRoom(roomId, name, ownerHash, requireApproval) {
      // room persists (expires_at NULL); entry is via rotating invite codes (see addInvite).
      db.prepare(`INSERT INTO rooms(code_hash,room_name,owner_hash,require_approval,created_at,expires_at)
                  VALUES(?,?,?,?,?,NULL)`).run(roomId, name || "", ownerHash, requireApproval ? 1 : 0, now());
      return true;
    },
    getTeamRoom(roomId) {
      return db.prepare(`SELECT code_hash AS room_id, room_name AS name, owner_hash, require_approval
                         FROM rooms WHERE code_hash=?`).get(roomId) || null;
    },
    activeRoomsTotal() {
      return db.prepare(`SELECT COUNT(*) AS n FROM rooms WHERE expires_at IS NULL OR expires_at > ?`).get(now()).n;
    },
    // ---- invites (rotating, expiring) ----
    addInvite(inviteHash, roomId, ttlMs) {
      db.prepare(`INSERT INTO invites(invite_hash,room_id,expires_at,revoked,created_at)
                  VALUES(?,?,?,0,?)`).run(inviteHash, roomId, now() + ttlMs, now());
    },
    // resolve an invite code hash → room_id, only if not expired and not revoked.
    resolveInvite(inviteHash) {
      const r = db.prepare(`SELECT room_id,expires_at,revoked FROM invites WHERE invite_hash=?`).get(inviteHash);
      if (!r || r.revoked || (r.expires_at && r.expires_at <= now())) return null;
      return r.room_id;
    },
    revokeInvitesForRoom(roomId) {
      db.prepare(`UPDATE invites SET revoked=1 WHERE room_id=?`).run(roomId);
    },
    // remember a handoff that flowed through a room, and list them for consolidation.
    addRoomHandoff(roomId, code) {
      try { db.prepare(`INSERT OR IGNORE INTO room_handoffs(room_id,code,created_at) VALUES(?,?,?)`).run(roomId, code, now()); } catch { /* ignore */ }
    },
    roomHandoffCodes(roomId) {
      return db.prepare(`SELECT code FROM room_handoffs WHERE room_id=? ORDER BY created_at`).all(roomId).map((r) => r.code);
    },
    // ---- members (room_id based) ----
    memberCount(roomId, windowMs = 180_000) {
      return db.prepare(`SELECT COUNT(*) AS n FROM members WHERE room_hash=? AND approved=1 AND last_seen > ?`)
        .get(roomId, now() - windowMs).n;
    },
    leaveMember(roomId, memberId) {
      return db.prepare(`DELETE FROM members WHERE room_hash=? AND id=?`).run(roomId, memberId).changes > 0;
    },
    touchMember(memberId) {
      db.prepare(`UPDATE members SET last_seen=? WHERE id=?`).run(now(), memberId);
    },
    getAccountPlan(keyHash) {
      if (!keyHash) return "free";
      const a = db.prepare(`SELECT plan FROM accounts WHERE key_hash=?`).get(keyHash);
      return a?.plan || "free";
    },
    teamJoin(roomId, alias, model, approved) {
      const id = participantId();
      db.prepare(`INSERT INTO members(id,room_hash,alias,model,joined_at,last_seen,approved)
                  VALUES(?,?,?,?,?,?,?)`).run(id, roomId, alias, model || "unknown", now(), now(), approved ? 1 : 0);
      return { id, room_id: roomId };
    },
    // member_id → { room_id, alias, approved } — lets send/inbox/who work off member_id (the
    // invite code is just an entry ticket that rotates; activity is keyed by member).
    memberRoom(memberId) {
      const m = db.prepare(`SELECT room_hash AS room_id, alias, approved FROM members WHERE id=?`).get(memberId);
      return m || null;
    },
    members(roomId) {
      return db.prepare(`SELECT id,alias,model,last_seen,approved FROM members WHERE room_hash=? ORDER BY joined_at`).all(roomId);
    },
    aliasTaken(roomId, alias) {
      return !!db.prepare(`SELECT 1 FROM members WHERE room_hash=? AND lower(alias)=lower(?)`).get(roomId, alias);
    },
    approveMember(roomId, memberId) {
      return db.prepare(`UPDATE members SET approved=1 WHERE room_hash=? AND id=?`).run(roomId, memberId).changes > 0;
    },

    // ---- messages (plaintext body — server-managed team rooms) ----
    send(roomId, fromId, fromAlias, toAlias, text) {
      const seqRow = db.prepare(`SELECT COALESCE(MAX(seq),0)+1 AS n FROM messages WHERE room_hash=?`).get(roomId);
      db.prepare(`INSERT INTO messages(room_hash,seq,from_id,from_alias,to_alias,body,created_at)
                  VALUES(?,?,?,?,?,?,?)`).run(roomId, seqRow.n, fromId, fromAlias, toAlias || null, text, now());
      db.prepare(`UPDATE members SET last_seen=? WHERE id=?`).run(now(), fromId);
      return seqRow.n;
    },
    inbox(roomId, myAlias, sinceSeq = 0, limit = 200) {
      const rows = db.prepare(
        `SELECT seq,from_alias,to_alias,body,created_at FROM messages
         WHERE room_hash=? AND seq>? AND (to_alias IS NULL OR lower(to_alias)=lower(?))
         ORDER BY seq LIMIT ?`).all(roomId, sinceSeq, myAlias, Math.min(limit, 500));
      return rows.map((m) => ({ seq: m.seq, from: m.from_alias, to: m.to_alias, at: m.created_at, text: m.body }));
    },

    // ---- snapshots (handoff) ----
    putSnapshot(code, meta, sealedBundle, { oneTime = false, ttlMs, verified = 0, manifest = null, parentCode = null } = {}) {
      // M3-4: if this handoff supersedes a parent, inherit its version+1 and link back.
      let parentHash = null, version = 1;
      if (parentCode) {
        parentHash = codeHash(parentCode);
        const p = db.prepare(`SELECT version FROM snapshots WHERE code_hash=?`).get(parentHash);
        if (p) version = (p.version || 1) + 1;
      }
      db.prepare(`INSERT INTO snapshots(code_hash,title,author,source_model,project,salt,iv,tag,ct,
                  verified,verify_manifest,one_time,consumed,created_at,expires_at,parent_hash,version)
                  VALUES(?,?,?,?,?,?,?,?,?,?,?,?,0,?,?,?,?)`).run(
        codeHash(code), meta.title, meta.author, meta.source_model, meta.project,
        sealedBundle.salt, sealedBundle.iv, sealedBundle.tag, sealedBundle.ct,
        verified ? 1 : 0, manifest ? JSON.stringify(manifest) : null,
        oneTime ? 1 : 0, now(), ttlMs ? now() + ttlMs : null, parentHash, version);
      return { version };
    },
    // M3-4: read a snapshot body by code WITHOUT consuming it (for diff). Returns null if gone.
    peekSnapshot(code) {
      const row = db.prepare(`SELECT * FROM snapshots WHERE code_hash=?`).get(codeHash(code));
      // HIGH-2: a consumed one-time snapshot must not be re-readable via diff/peek either.
      if (!alive(row) || row.consumed) return null;
      return {
        meta: { title: row.title, project: row.project, author: row.author, source_model: row.source_model },
        version: row.version || 1,
        verified: !!row.verified,
        manifest: row.verify_manifest ? JSON.parse(row.verify_manifest) : null,
        body: JSON.parse(openBody(code, row)),
      };
    },
    // Atomic one-time redemption: returns the row only if it wasn't already consumed (H4 TOCTOU).
    takeSnapshot(code) {
      const h = codeHash(code);
      const tx = db.transaction(() => {
        const row = db.prepare(`SELECT * FROM snapshots WHERE code_hash=?`).get(h);
        if (!alive(row) || row.consumed) return null;
        if (row.one_time) db.prepare(`UPDATE snapshots SET consumed=1 WHERE code_hash=? AND consumed=0`).run(h);
        return row;
      });
      const row = tx();
      if (!row) return null;
      return {
        meta: { title: row.title, author: row.author, source_model: row.source_model, project: row.project },
        body: openBody(code, row),
        verified: !!row.verified,
        manifest: row.verify_manifest ? JSON.parse(row.verify_manifest) : null,
        created_at: row.created_at,
      };
    },
    // Handoff shred: destroy a snapshot by its code.
    revoke(code) {
      return db.prepare(`DELETE FROM snapshots WHERE code_hash=?`).run(codeHash(code)).changes > 0;
    },
    // Owner closes a team room: shred the room + its invites + members + messages.
    deleteRoom(roomId) {
      const tx = db.transaction(() => {
        const n = db.prepare(`DELETE FROM rooms WHERE code_hash=?`).run(roomId).changes;
        db.prepare(`DELETE FROM invites WHERE room_id=?`).run(roomId);
        db.prepare(`DELETE FROM messages WHERE room_hash=?`).run(roomId);
        db.prepare(`DELETE FROM members WHERE room_hash=?`).run(roomId);
        return n > 0;
      });
      return tx();
    },

    // ---- shared spider corpus (M2-2) ----
    // Upsert by fingerprint; accumulate hits + distinct contributors; promote to verified at threshold.
    upsertPattern(rec, verifyThreshold = 3) {
      const tx = db.transaction(() => {
        const existing = db.prepare(`SELECT * FROM spider_patterns WHERE fingerprint=?`).get(rec.fingerprint);
        let action;
        if (!existing) {
          db.prepare(`INSERT INTO spider_patterns(fingerprint,klass,name,signal,fix,tags,severity,tier,hit_count,contributor_count,verified,created_at,updated_at)
                      VALUES(?,?,?,?,?,?,?,?,1,1,0,?,?)`).run(
            rec.fingerprint, rec.klass, rec.name, rec.signal, rec.fix, JSON.stringify(rec.tags || []),
            rec.severity, rec.tier, now(), now());
          action = "created";
        } else {
          db.prepare(`UPDATE spider_patterns SET hit_count=hit_count+1, updated_at=? WHERE fingerprint=?`).run(now(), rec.fingerprint);
          action = "merged";
        }
        // distinct-contributor accounting (by token hash)
        const isNew = db.prepare(`INSERT OR IGNORE INTO spider_contributions(fingerprint,contributor_hash,ip_hash,created_at) VALUES(?,?,?,?)`)
          .run(rec.fingerprint, rec.contributor_hash, rec.ip_hash || null, now()).changes > 0;
        if (isNew && existing) db.prepare(`UPDATE spider_patterns SET contributor_count=contributor_count+1 WHERE fingerprint=?`).run(rec.fingerprint);
        // VERIFIED requires diversity on BOTH axes: ≥threshold distinct tokens AND ≥threshold distinct IPs.
        // Rotating only the token from one machine no longer forges a verified badge (live attack #7).
        const distinctIps = db.prepare(`SELECT COUNT(DISTINCT ip_hash) AS n FROM spider_contributions WHERE fingerprint=? AND ip_hash IS NOT NULL`).get(rec.fingerprint).n;
        const cc = db.prepare(`SELECT contributor_count FROM spider_patterns WHERE fingerprint=?`).get(rec.fingerprint).contributor_count;
        if (cc >= verifyThreshold && distinctIps >= verifyThreshold)
          db.prepare(`UPDATE spider_patterns SET verified=1 WHERE fingerprint=?`).run(rec.fingerprint);
        const row = db.prepare(`SELECT hit_count,contributor_count,verified FROM spider_patterns WHERE fingerprint=?`).get(rec.fingerprint);
        return { action, ...row, verified: !!row.verified, distinct_ips: distinctIps };
      });
      return tx();
    },
    queryPatterns({ tags = [], klass, limit = 50 } = {}) {
      let rows = db.prepare(`SELECT klass,name,signal,fix,tags,severity,tier,hit_count,contributor_count,verified
                             FROM spider_patterns ORDER BY verified DESC, hit_count DESC LIMIT ?`).all(Math.min(limit, 200));
      rows = rows.map((r) => ({ ...r, verified: !!r.verified, tags: JSON.parse(r.tags || "[]") }));
      if (klass) rows = rows.filter((r) => r.klass === klass || r.klass.includes(klass));
      if (tags.length) rows = rows.filter((r) => r.tags.some((t) => tags.includes(t.toLowerCase())));
      return rows;
    },
    // ---- accounts + usage (M3-3) ----
    getAccount(keyHash) {
      return db.prepare(`SELECT plan, org, created_at FROM accounts WHERE key_hash=?`).get(keyHash) || null;
    },
    upsertAccount(keyHash, { plan = "free", emailHash = null, org = null } = {}) {
      db.prepare(`INSERT INTO accounts(key_hash,plan,email_hash,org,created_at) VALUES(?,?,?,?,?)
                  ON CONFLICT(key_hash) DO UPDATE SET plan=excluded.plan, org=excluded.org`)
        .run(keyHash, plan, emailHash, org, now());
      return true;
    },
    getUsage(keyHash, kind, period) {
      const r = db.prepare(`SELECT count FROM usage_counters WHERE key_hash=? AND kind=? AND period=?`).get(keyHash, kind, period);
      return r ? r.count : 0;
    },
    bumpUsage(keyHash, kind, period) {
      db.prepare(`INSERT INTO usage_counters(key_hash,kind,period,count) VALUES(?,?,?,1)
                  ON CONFLICT(key_hash,kind,period) DO UPDATE SET count=count+1`).run(keyHash, kind, period);
    },
    activeRoomCount(keyHash) {
      // rooms don't carry an owner column in MVP; count via a usage counter instead.
      return this.getUsage(keyHash, "rooms_active", "all");
    },

    // ---- operations: task graph / Git evidence / cost ledger ----
    createTask(row) {
      db.prepare(`INSERT INTO tasks(id,owner_hash,room_id,title,status,assignee,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)`)
        .run(row.id, row.owner_hash, row.room_id || null, row.title, row.status || "todo", row.assignee || null, now(), now());
      return this.getTask(row.owner_hash, row.id);
    },
    getTask(ownerHash, id) { return db.prepare(`SELECT * FROM tasks WHERE owner_hash=? AND id=?`).get(ownerHash, id) || null; },
    updateTask(ownerHash, id, status) {
      db.prepare(`UPDATE tasks SET status=?,updated_at=? WHERE owner_hash=? AND id=?`).run(status, now(), ownerHash, id);
      return this.getTask(ownerHash, id);
    },
    addTaskEdge(ownerHash, from, to, type) {
      db.prepare(`INSERT OR IGNORE INTO task_edges(owner_hash,from_task_id,to_task_id,edge_type,created_at) VALUES(?,?,?,?,?)`)
        .run(ownerHash, from, to, type, now());
    },
    taskGraph(ownerHash) {
      return {
        tasks: db.prepare(`SELECT * FROM tasks WHERE owner_hash=? ORDER BY created_at`).all(ownerHash),
        edges: db.prepare(`SELECT from_task_id,to_task_id,edge_type FROM task_edges WHERE owner_hash=? ORDER BY created_at`).all(ownerHash),
      };
    },
    addGitEvidence(row) {
      db.prepare(`INSERT INTO git_evidence(id,owner_hash,task_id,repository,commit_sha,branch,diff_sha256,test_command,test_exit_code,artifact_refs,recorded_at)
                  VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(row.id,row.owner_hash,row.task_id||null,row.repository,row.commit_sha,row.branch||null,row.diff_sha256||null,row.test_command||null,row.test_exit_code??null,JSON.stringify(row.artifact_refs||[]),now());
      return { ...row, artifact_refs: row.artifact_refs || [] };
    },
    gitEvidence(ownerHash, taskId = null) {
      const rows = taskId
        ? db.prepare(`SELECT * FROM git_evidence WHERE owner_hash=? AND task_id=? ORDER BY recorded_at DESC`).all(ownerHash,taskId)
        : db.prepare(`SELECT * FROM git_evidence WHERE owner_hash=? ORDER BY recorded_at DESC LIMIT 200`).all(ownerHash);
      return rows.map((r) => ({ ...r, artifact_refs: JSON.parse(r.artifact_refs || "[]") }));
    },
    addCostEvent(row) {
      const inserted = db.prepare(`INSERT OR IGNORE INTO cost_events(id,owner_hash,task_id,provider,model,input_tokens,output_tokens,amount_usd,source,idempotency_key,occurred_at)
                                   VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(row.id,row.owner_hash,row.task_id||null,row.provider,row.model||null,row.input_tokens||0,row.output_tokens||0,row.amount_usd,row.source,row.idempotency_key,row.occurred_at||now()).changes;
      return { inserted: !!inserted };
    },
    costSummary(ownerHash) {
      const totals = db.prepare(`SELECT COUNT(*) events,COALESCE(SUM(amount_usd),0) amount_usd,COALESCE(SUM(input_tokens),0) input_tokens,COALESCE(SUM(output_tokens),0) output_tokens FROM cost_events WHERE owner_hash=?`).get(ownerHash);
      const by_provider = db.prepare(`SELECT provider,model,COUNT(*) events,SUM(amount_usd) amount_usd,SUM(input_tokens) input_tokens,SUM(output_tokens) output_tokens FROM cost_events WHERE owner_hash=? GROUP BY provider,model ORDER BY amount_usd DESC`).all(ownerHash);
      const by_task = db.prepare(`SELECT task_id,COUNT(*) events,SUM(amount_usd) amount_usd FROM cost_events WHERE owner_hash=? GROUP BY task_id ORDER BY amount_usd DESC`).all(ownerHash);
      return { totals, by_provider, by_task };
    },

    // ---- crypto invoices (M3-5) ----
    createInvoice(id, keyHash, plan, amount) {
      db.prepare(`INSERT INTO invoices(id,key_hash,plan,amount,status,created_at) VALUES(?,?,?,?,'pending',?)`)
        .run(id, keyHash, plan, amount, now());
      return true;
    },
    getInvoice(id) { return db.prepare(`SELECT * FROM invoices WHERE id=?`).get(id) || null; },
    // Atomically settle an invoice + burn the tx hash (replay guard) + upgrade the account.
    settleInvoice(id, { chain, txHash, plan, keyHash, token = null, actualAmount = null }) {
      const tx = db.transaction(() => {
        const inv = db.prepare(`SELECT status FROM invoices WHERE id=?`).get(id);
        if (!inv || inv.status === "paid") return { ok: false, reason: "invoice missing or already paid" };
        const used = db.prepare(`INSERT OR IGNORE INTO used_txs(tx_hash,chain,invoice_id,created_at) VALUES(?,?,?,?)`)
          .run(txHash, chain, id, now()).changes;
        if (!used) return { ok: false, reason: "this tx hash was already used" };
        db.prepare(`UPDATE invoices SET status='paid', chain=?, tx_hash=?, token=?, actual_amount=? WHERE id=?`)
          .run(chain, txHash, token, actualAmount, id);
        db.prepare(`INSERT INTO accounts(key_hash,plan,created_at) VALUES(?,?,?)
                    ON CONFLICT(key_hash) DO UPDATE SET plan=excluded.plan`).run(keyHash, plan, now());
        return { ok: true };
      });
      return tx();
    },
    _db: db,
  };

  function safeOpen(code, r) { try { return openBody(code, r); } catch { return null; } }
}
