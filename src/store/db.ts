import path from "path";
import os from "os";
import fs from "fs";
import crypto from "crypto";
import { createRequire } from "module";
import type { RawItem, SourceItem, ProfileSnapshot } from "../schema";

const _require = createRequire(import.meta.url);

let _db: ReturnType<typeof openDb> | null = null;

function openDb() {
  const Database = _require("better-sqlite3");

  const dir = path.join(os.homedir(), ".local", "share", "scout-scraper");
  fs.mkdirSync(dir, { recursive: true });
  const dbPath = path.join(dir, "scout.db");

  const db = new Database(dbPath);

  // WAL mode for concurrent reads
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");

  db.exec(`
    CREATE TABLE IF NOT EXISTS runs (
      run_id TEXT PRIMARY KEY,
      query TEXT NOT NULL,
      intent TEXT,
      source_count INTEGER DEFAULT 0,
      item_count INTEGER DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS items (
      id TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT,
      url TEXT NOT NULL,
      author TEXT,
      engagement_json TEXT,
      scout_score REAL DEFAULT 0,
      rrf_score REAL DEFAULT 0,
      run_id TEXT,
      published_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (run_id) REFERENCES runs(run_id)
    );

    CREATE TABLE IF NOT EXISTS profile_snapshots (
      id TEXT PRIMARY KEY,
      platform TEXT NOT NULL,
      handle TEXT NOT NULL,
      fetched_at TEXT NOT NULL,
      followers INTEGER DEFAULT 0,
      posts_json TEXT,
      stats_json TEXT,
      data_json TEXT,
      UNIQUE(platform, handle, fetched_at)
    );

    CREATE TABLE IF NOT EXISTS resolved_threads (
      platform TEXT NOT NULL,
      comment_id TEXT NOT NULL,
      resolved_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_reply_at TEXT,
      close_reason TEXT,
      PRIMARY KEY (platform, comment_id)
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS items_fts USING fts5(
      title, body,
      content='items',
      content_rowid='rowid',
      tokenize='porter unicode61'
    );

    CREATE TRIGGER IF NOT EXISTS items_ai AFTER INSERT ON items BEGIN
      INSERT INTO items_fts(rowid, title, body) VALUES (new.rowid, new.title, new.body);
    END;
    CREATE TRIGGER IF NOT EXISTS items_au AFTER UPDATE ON items BEGIN
      INSERT INTO items_fts(items_fts, rowid, title, body) VALUES ('delete', old.rowid, old.title, old.body);
      INSERT INTO items_fts(rowid, title, body) VALUES (new.rowid, new.title, new.body);
    END;
  `);

  // Migration: add data_json column if it doesn't exist yet
  const cols = db.pragma("table_info(profile_snapshots)") as Array<{ name: string }>;
  if (!cols.some((c) => c.name === "data_json")) {
    db.exec(`ALTER TABLE profile_snapshots ADD COLUMN data_json TEXT`);
  }

  // Migration: add last_reply_at + close_reason to resolved_threads
  const threadCols = db.pragma("table_info(resolved_threads)") as Array<{ name: string }>;
  if (!threadCols.some((c) => c.name === "last_reply_at")) {
    db.exec(`ALTER TABLE resolved_threads ADD COLUMN last_reply_at TEXT`);
  }
  if (!threadCols.some((c) => c.name === "close_reason")) {
    db.exec(`ALTER TABLE resolved_threads ADD COLUMN close_reason TEXT`);
  }

  return db;
}

function getDb() {
  if (!_db) _db = openDb();
  return _db;
}

export function urlToId(url: string): string {
  const normalized = url.trim().toLowerCase().replace(/\/$/, "");
  return crypto.createHash("sha256").update(normalized).digest("hex").slice(0, 32);
}

export function saveRun(runId: string, query: string, intent?: string) {
  const db = getDb();
  db.prepare(
    `INSERT OR IGNORE INTO runs (run_id, query, intent) VALUES (?, ?, ?)`
  ).run(runId, query, intent ?? null);
}

export function saveItems(items: SourceItem[], runId: string) {
  const db = getDb();
  const upsert = db.prepare(`
    INSERT INTO items (id, source, title, body, url, author, engagement_json, scout_score, rrf_score, run_id, published_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      engagement_json = excluded.engagement_json,
      scout_score = excluded.scout_score,
      rrf_score = excluded.rrf_score,
      run_id = excluded.run_id
  `);

  const insertMany = db.transaction((rows: SourceItem[]) => {
    for (const item of rows) {
      upsert.run(
        item.id,
        item.source,
        item.title,
        item.body,
        item.url,
        item.author,
        JSON.stringify(item.engagement),
        item.scoutScore,
        item.rrfScore,
        runId,
        item.publishedAt
      );
    }
  });
  insertMany(items);
}

export function saveProfileSnapshot(snapshot: ProfileSnapshot) {
  const db = getDb();
  const id = crypto.randomUUID();
  db.prepare(`
    INSERT OR REPLACE INTO profile_snapshots (id, platform, handle, fetched_at, followers, posts_json, stats_json, data_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    snapshot.platform,
    snapshot.handle,
    snapshot.fetchedAt,
    snapshot.followers,
    JSON.stringify(snapshot.posts),
    JSON.stringify(snapshot.stats),
    JSON.stringify(snapshot)
  );
}

export function searchItems(q: string, limit = 20): RawItem[] {
  const db = getDb();
  const stmt = db.prepare(`
    SELECT i.* FROM items_fts
    JOIN items i ON items_fts.rowid = i.rowid
    WHERE items_fts MATCH ?
    ORDER BY rank
    LIMIT ?
  `);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- SQLite raw row shape varies at runtime; normalized via rowToItem
  const rows = stmt.all(q + "*", limit) as any[];
  return rows.map(rowToItem);
}

export function getRecentItems(limit = 50): RawItem[] {
  const db = getDb();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- SQLite raw row shape varies at runtime; normalized via rowToItem
  const rows = db.prepare(`SELECT * FROM items ORDER BY created_at DESC LIMIT ?`).all(limit) as any[];
  return rows.map(rowToItem);
}

export function getLatestProfileSnapshot(platform: string): ProfileSnapshot | null {
  const db = getDb();
  const snapshotStmt = db.prepare(`
    SELECT * FROM profile_snapshots WHERE platform = ?
    ORDER BY fetched_at DESC LIMIT 1
  `);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- SQLite raw snapshot row shape varies at runtime; fields accessed by column name
  const row = snapshotStmt.get(platform) as any;
  if (!row) return null;
  // Prefer full snapshot JSON if available (includes avatarUrl, bannerUrl, displayName, pendingThreads)
  if (row.data_json) {
    try { return JSON.parse(row.data_json) as ProfileSnapshot; } catch { /* fall through */ }
  }
  return {
    platform: row.platform,
    handle: row.handle,
    fetchedAt: row.fetched_at,
    followers: row.followers,
    posts: JSON.parse(row.posts_json ?? "[]"),
    stats: JSON.parse(row.stats_json ?? "{}"),
  };
}

export type CloseReason = "REPLIED" | "UPVOTED" | "NOT_NEEDED";

export function resolveThread(
  platform: string,
  commentId: string,
  opts?: { lastReplyAt?: string; closeReason?: CloseReason },
): void {
  const db = getDb();
  db.prepare(
    `INSERT OR REPLACE INTO resolved_threads (platform, comment_id, last_reply_at, close_reason)
     VALUES (?, ?, ?, ?)`
  ).run(platform, commentId, opts?.lastReplyAt ?? null, opts?.closeReason ?? null);
}

export function isThreadResolved(platform: string, commentId: string): boolean {
  const db = getDb();
  const row = db.prepare(`SELECT 1 FROM resolved_threads WHERE platform=? AND comment_id=?`)
    .get(platform, commentId);
  return !!row;
}

/** Returns the stored close state for a resolved thread, or null if not resolved. */
export function getThreadCloseState(
  platform: string,
  commentId: string,
): { lastReplyAt: string | null; closeReason: CloseReason | null } | null {
  const db = getDb();
  const row = db.prepare(
    `SELECT last_reply_at, close_reason FROM resolved_threads WHERE platform=? AND comment_id=?`
  ).get(platform, commentId) as { last_reply_at: string | null; close_reason: string | null } | undefined;
  if (!row) return null;
  return { lastReplyAt: row.last_reply_at, closeReason: row.close_reason as CloseReason | null };
}

/** Remove a resolved thread so it surfaces again on the next scan. */
export function reopenThread(platform: string, commentId: string): void {
  const db = getDb();
  db.prepare(`DELETE FROM resolved_threads WHERE platform=? AND comment_id=?`).run(platform, commentId);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- SQLite raw row object shape varies at runtime; columns accessed by name
function rowToItem(row: any): RawItem {
  return {
    id: row.id,
    source: row.source,
    title: row.title,
    body: row.body ?? "",
    url: row.url,
    author: row.author ?? "",
    engagement: JSON.parse(row.engagement_json ?? "{}"),
    scoutScore: row.scout_score,
    publishedAt: row.published_at ?? "",
  };
}
