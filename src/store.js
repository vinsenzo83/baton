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
  // C1: purge any corpus rows containing HTML/angle-brackets (stored-XSS cleanup, idempotent).
  try { db.exec(`DELETE FROM spider_patterns WHERE name LIKE '%<%' OR name LIKE '%>%'
                 OR signal LIKE '%<%' OR fix LIKE '%<%' OR klass LIKE '%<%'`); } catch { /* table may not exist yet */ }

  const now = () => Date.now();
  const alive = (row) => row && (!row.expires_at || row.expires_at > now());

  return {
    // ---- rooms ----
    createRoom(code, name, ttlMs, ownerHash = null) {
      const s = sealBody(code, name || "");
      db.prepare(`INSERT INTO rooms(code_hash,name,salt,iv,tag,ct,created_at,expires_at,owner_hash)
                  VALUES(?,?,?,?,?,?,?,?,?)`).run(
        codeHash(code), null, s.salt, s.iv, s.tag, s.ct, now(), ttlMs ? now() + ttlMs : null, ownerHash);
      return true;
    },
    // Count an owner's still-alive rooms (for the activeRooms limit).
    ownerActiveRooms(ownerHash) {
      if (!ownerHash) return 0;
      return db.prepare(`SELECT COUNT(*) AS n FROM rooms WHERE owner_hash=? AND (expires_at IS NULL OR expires_at > ?)`)
        .get(ownerHash, now()).n;
    },
    // Global active-room count (admin stat).
    activeRoomsTotal() {
      return db.prepare(`SELECT COUNT(*) AS n FROM rooms WHERE expires_at IS NULL OR expires_at > ?`).get(now()).n;
    },
    getRoom(code) {
      const r = db.prepare(`SELECT * FROM rooms WHERE code_hash=?`).get(codeHash(code));
      if (!alive(r)) return null;
      return { ...r, name: safeOpen(code, r) };
    },
    // Concurrent = members seen within the active window (default 3 min). A session that
    // stopped polling frees its seat, so "seats" means concurrent, not lifetime joins (🟠2).
    memberCount(roomHash, windowMs = 180_000) {
      return db.prepare(`SELECT COUNT(*) AS n FROM members WHERE room_hash=? AND last_seen > ?`)
        .get(roomHash, now() - windowMs).n;
    },
    // Explicit leave frees the seat immediately.
    leaveMember(roomHash, memberId) {
      return db.prepare(`DELETE FROM members WHERE room_hash=? AND id=?`).run(roomHash, memberId).changes > 0;
    },
    touchMember(memberId) {
      db.prepare(`UPDATE members SET last_seen=? WHERE id=?`).run(now(), memberId);
    },
    getAccountPlan(keyHash) {
      if (!keyHash) return "free";
      const a = db.prepare(`SELECT plan FROM accounts WHERE key_hash=?`).get(keyHash);
      return a?.plan || "free";
    },
    join(code, alias, model) {
      const r = db.prepare(`SELECT * FROM rooms WHERE code_hash=?`).get(codeHash(code));
      if (!alive(r)) return null;
      const id = participantId();
      db.prepare(`INSERT INTO members(id,room_hash,alias,model,joined_at,last_seen)
                  VALUES(?,?,?,?,?,?)`).run(id, r.code_hash, alias, model || "unknown", now(), now());
      return { id, room_hash: r.code_hash };
    },
    members(roomHash) {
      return db.prepare(`SELECT id,alias,model,last_seen FROM members WHERE room_hash=? ORDER BY joined_at`).all(roomHash);
    },
    aliasTaken(roomHash, alias) {
      return !!db.prepare(`SELECT 1 FROM members WHERE room_hash=? AND lower(alias)=lower(?)`).get(roomHash, alias);
    },

    // ---- messages ----
    // DoS fix: derive the room key ONCE per call from the room salt, reuse across messages
    // (aes-gcm with a per-message iv) instead of running scrypt per message.
    send(code, roomHash, fromId, fromAlias, toAlias, text) {
      const room = db.prepare(`SELECT salt FROM rooms WHERE code_hash=?`).get(roomHash);
      const key = deriveKey(code, Buffer.from(room.salt, "base64"));
      const seqRow = db.prepare(`SELECT COALESCE(MAX(seq),0)+1 AS n FROM messages WHERE room_hash=?`).get(roomHash);
      const s = sealWithKey(key, text);
      db.prepare(`INSERT INTO messages(room_hash,seq,from_id,from_alias,to_alias,salt,iv,tag,ct,created_at)
                  VALUES(?,?,?,?,?,?,?,?,?,?)`).run(
        roomHash, seqRow.n, fromId, fromAlias, toAlias || null, null, s.iv, s.tag, s.ct, now());
      db.prepare(`UPDATE members SET last_seen=? WHERE id=?`).run(now(), fromId);
      return seqRow.n;
    },
    inbox(code, roomHash, myAlias, sinceSeq = 0, limit = 200) {
      const room = db.prepare(`SELECT salt FROM rooms WHERE code_hash=?`).get(roomHash);
      const key = deriveKey(code, Buffer.from(room.salt, "base64"));   // one derivation for all rows
      const rows = db.prepare(
        `SELECT seq,from_alias,to_alias,salt,iv,tag,ct,created_at FROM messages
         WHERE room_hash=? AND seq>? AND (to_alias IS NULL OR lower(to_alias)=lower(?))
         ORDER BY seq LIMIT ?`).all(roomHash, sinceSeq, myAlias, Math.min(limit, 500));
      return rows.map((m) => ({
        seq: m.seq, from: m.from_alias, to: m.to_alias, at: m.created_at,
        // rows with a legacy per-message salt fall back to per-message derivation
        text: m.salt ? openBody(code, m) : openWithKey(key, m),
      }));
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
      return { meta: { title: row.title, project: row.project }, version: row.version || 1,
        body: JSON.parse(openBody(code, row)) };
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
    revoke(code) {
      const h = codeHash(code);
      // L1: actually shred everything under this code — messages/members too, not just the room row.
      const tx = db.transaction(() => {
        const a = db.prepare(`DELETE FROM snapshots WHERE code_hash=?`).run(h).changes;
        const b = db.prepare(`DELETE FROM rooms WHERE code_hash=?`).run(h).changes;
        db.prepare(`DELETE FROM messages WHERE room_hash=?`).run(h);
        db.prepare(`DELETE FROM members WHERE room_hash=?`).run(h);
        return a + b > 0;
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
