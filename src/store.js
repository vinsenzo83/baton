// BATON storage. SQLite for MVP/self-host; the interface is narrow so a Postgres
// adapter can drop in for the hosted service (arch review M1). Bodies are sealed with
// code-derived keys — the DB never holds plaintext or the code itself (C4).
import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { sealBody, openBody, codeHash } from "./crypto.js";
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
      fingerprint TEXT, contributor_hash TEXT, created_at INTEGER,
      UNIQUE(fingerprint, contributor_hash)
    );
  `);

  const now = () => Date.now();
  const alive = (row) => row && (!row.expires_at || row.expires_at > now());

  return {
    // ---- rooms ----
    createRoom(code, name, ttlMs) {
      const s = sealBody(code, name || "");
      db.prepare(`INSERT INTO rooms(code_hash,name,salt,iv,tag,ct,created_at,expires_at)
                  VALUES(?,?,?,?,?,?,?,?)`).run(
        codeHash(code), null, s.salt, s.iv, s.tag, s.ct, now(), ttlMs ? now() + ttlMs : null);
      return true;
    },
    getRoom(code) {
      const r = db.prepare(`SELECT * FROM rooms WHERE code_hash=?`).get(codeHash(code));
      if (!alive(r)) return null;
      return { ...r, name: safeOpen(code, r) };
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
    send(code, roomHash, fromId, fromAlias, toAlias, text) {
      const seqRow = db.prepare(`SELECT COALESCE(MAX(seq),0)+1 AS n FROM messages WHERE room_hash=?`).get(roomHash);
      const s = sealBody(code, text);
      db.prepare(`INSERT INTO messages(room_hash,seq,from_id,from_alias,to_alias,salt,iv,tag,ct,created_at)
                  VALUES(?,?,?,?,?,?,?,?,?,?)`).run(
        roomHash, seqRow.n, fromId, fromAlias, toAlias || null, s.salt, s.iv, s.tag, s.ct, now());
      db.prepare(`UPDATE members SET last_seen=? WHERE id=?`).run(now(), fromId);
      return seqRow.n;
    },
    inbox(code, roomHash, myAlias, sinceSeq = 0) {
      const rows = db.prepare(
        `SELECT seq,from_alias,to_alias,salt,iv,tag,ct,created_at FROM messages
         WHERE room_hash=? AND seq>? AND (to_alias IS NULL OR lower(to_alias)=lower(?))
         ORDER BY seq`).all(roomHash, sinceSeq, myAlias);
      return rows.map((m) => ({
        seq: m.seq, from: m.from_alias, to: m.to_alias, at: m.created_at,
        text: openBody(code, m),
      }));
    },

    // ---- snapshots (handoff) ----
    putSnapshot(code, meta, sealedBundle, { oneTime = false, ttlMs, verified = 0, manifest = null } = {}) {
      db.prepare(`INSERT INTO snapshots(code_hash,title,author,source_model,project,salt,iv,tag,ct,
                  verified,verify_manifest,one_time,consumed,created_at,expires_at)
                  VALUES(?,?,?,?,?,?,?,?,?,?,?,?,0,?,?)`).run(
        codeHash(code), meta.title, meta.author, meta.source_model, meta.project,
        sealedBundle.salt, sealedBundle.iv, sealedBundle.tag, sealedBundle.ct,
        verified ? 1 : 0, manifest ? JSON.stringify(manifest) : null,
        oneTime ? 1 : 0, now(), ttlMs ? now() + ttlMs : null);
      return true;
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
      const a = db.prepare(`DELETE FROM snapshots WHERE code_hash=?`).run(h).changes;
      const b = db.prepare(`DELETE FROM rooms WHERE code_hash=?`).run(h).changes;
      return a + b > 0;
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
        // distinct-contributor accounting → verified promotion
        const isNew = db.prepare(`INSERT OR IGNORE INTO spider_contributions(fingerprint,contributor_hash,created_at) VALUES(?,?,?)`)
          .run(rec.fingerprint, rec.contributor_hash, now()).changes > 0;
        if (isNew && existing) db.prepare(`UPDATE spider_patterns SET contributor_count=contributor_count+1 WHERE fingerprint=?`).run(rec.fingerprint);
        const cc = db.prepare(`SELECT contributor_count FROM spider_patterns WHERE fingerprint=?`).get(rec.fingerprint).contributor_count;
        if (cc >= verifyThreshold) db.prepare(`UPDATE spider_patterns SET verified=1 WHERE fingerprint=?`).run(rec.fingerprint);
        const row = db.prepare(`SELECT hit_count,contributor_count,verified FROM spider_patterns WHERE fingerprint=?`).get(rec.fingerprint);
        return { action, ...row, verified: !!row.verified };
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
    _db: db,
  };

  function safeOpen(code, r) { try { return openBody(code, r); } catch { return null; } }
}
