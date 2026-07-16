/**
 * CCR (Compress-Cache-Retrieve) Store
 *
 * When content is compressed, the original is stored here with a hash key.
 * The LLM can retrieve originals on demand via the headroom_retrieve tool.
 *
 * Storage: SQLite at ~/.headroom/ccr_store.db (same path as Python Headroom)
 * Survives process restarts and /reload.
 *
 * Mirrors: headroom/cache/compression_store.py + backends/sqlite.py
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const DEFAULT_TTL_MS = 30 * 60 * 1000; // 30 minutes
const MAX_ENTRIES = 500;
const PURGE_INTERVAL_MS = 60_000; // purge expired rows at most once per minute

export interface CCREntry {
  hash: string;
  original: string;
  compressed: string;
  strategy?: string;
  toolName?: string;
  createdAt: number;
  ttlMs: number;
  retrievalCount: number;
  lastAccessed?: number;
}

export class CCRStore {
  private db: DatabaseSync | null = null;
  private ttlMs: number;
  private dbPath: string;
  private lastPurge = 0;

  constructor(ttlMs = DEFAULT_TTL_MS, dbPath?: string) {
    this.ttlMs = ttlMs;
    this.dbPath = dbPath ?? join(homedir(), ".headroom", "pi-ccr-store.db");
    this.open();
  }

  /** Compute a 12-char hex hash of content. */
  static hash(content: string): string {
    return createHash("sha256").update(content).digest("hex").slice(0, 12);
  }

  /** Store original content and return the hash key. */
  store(original: string, compressed: string, toolName?: string, strategy?: string): string {
    const hash = CCRStore.hash(original);
    const now = Date.now();

    this.ensureDb();
    const stmt = this.db!.prepare(
      `INSERT OR REPLACE INTO ccr_entries (hash, original, compressed, strategy, tool_name, created_at, ttl_ms, retrieval_count, last_accessed)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, NULL)`
    );
    stmt.run(hash, original, compressed, strategy ?? null, toolName ?? null, now, this.ttlMs);

    this.maybePurge();
    return hash;
  }

  /** Retrieve original content by hash. Returns null if expired or not found. */
  retrieve(hash: string): CCREntry | null {
    this.ensureDb();
    const now = Date.now();
    const stmt = this.db!.prepare(
      "SELECT hash, original, compressed, strategy, tool_name, created_at, ttl_ms, retrieval_count, last_accessed FROM ccr_entries WHERE hash = ?"
    );
    const row = stmt.get(hash) as any;
    if (!row) return null;

    if (now - row.created_at > row.ttl_ms) {
      this.db!.prepare("DELETE FROM ccr_entries WHERE hash = ?").run(hash);
      return null;
    }

    // Update access
    this.db!.prepare(
      "UPDATE ccr_entries SET retrieval_count = retrieval_count + 1, last_accessed = ? WHERE hash = ?"
    ).run(now, hash);

    return {
      hash: row.hash,
      original: row.original,
      compressed: row.compressed,
      strategy: row.strategy,
      toolName: row.tool_name,
      createdAt: row.created_at,
      ttlMs: row.ttl_ms,
      retrievalCount: row.retrieval_count + 1,
      lastAccessed: now,
    };
  }

  /** Check if a hash exists and is not expired. */
  has(hash: string): boolean {
    this.ensureDb();
    const now = Date.now();
    const row = this.db!.prepare(
      "SELECT created_at, ttl_ms FROM ccr_entries WHERE hash = ?"
    ).get(hash) as any;
    if (!row) return false;
    if (now - row.created_at > row.ttl_ms) {
      this.db!.prepare("DELETE FROM ccr_entries WHERE hash = ?").run(hash);
      return false;
    }
    return true;
  }

  /** Get store size (live entries only). */
  get size(): number {
    this.ensureDb();
    const now = Date.now();
    const row = this.db!.prepare(
      "SELECT COUNT(*) as cnt FROM ccr_entries WHERE (? - created_at) <= ttl_ms"
    ).get(now) as any;
    return row?.cnt ?? 0;
  }

  /** Read the all-time number of characters saved by Pi compression. */
  getGlobalSavedChars(): number {
    this.ensureDb();
    const row = this.db!.prepare(
      "SELECT value FROM global_stats WHERE key = ?"
    ).get("saved_chars") as any;
    const value = Number(row?.value);
    return Number.isFinite(value) && value > 0 ? value : 0;
  }

  /** Persist the all-time number of characters saved by Pi compression. */
  setGlobalSavedChars(chars: number): void {
    this.ensureDb();
    const value = Number.isFinite(chars) && chars > 0 ? chars : 0;
    this.db!.prepare(
      "INSERT OR REPLACE INTO global_stats (key, value) VALUES (?, ?)"
    ).run("saved_chars", value);
  }

  /** Get stats. */
  stats(): { size: number; totalRetrievals: number; oldestAgeMs: number } {
    this.ensureDb();
    const now = Date.now();
    const row = this.db!.prepare(`
      SELECT COUNT(*) as cnt,
             COALESCE(SUM(retrieval_count), 0) as total_retrievals,
             COALESCE(MAX(? - created_at), 0) as oldest_age
      FROM ccr_entries
      WHERE (? - created_at) <= ttl_ms
    `).get(now, now) as any;
    return {
      size: row?.cnt ?? 0,
      totalRetrievals: row?.total_retrievals ?? 0,
      oldestAgeMs: row?.oldest_age ?? 0,
    };
  }

  // ── private ──────────────────────────────────────────────────────

  private open(): void {
    try {
      const dir = dirname(this.dbPath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

      this.db = new DatabaseSync(this.dbPath);
      this.db.exec("PRAGMA journal_mode = WAL");
      this.db.exec("PRAGMA busy_timeout = 3000");
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS ccr_entries (
          hash TEXT PRIMARY KEY,
          original TEXT NOT NULL,
          compressed TEXT NOT NULL,
          strategy TEXT,
          tool_name TEXT,
          created_at REAL NOT NULL,
          ttl_ms REAL NOT NULL,
          retrieval_count INTEGER NOT NULL DEFAULT 0,
          last_accessed REAL
        )
      `);
      this.db.exec("CREATE INDEX IF NOT EXISTS idx_ccr_expiry ON ccr_entries (created_at)");
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS global_stats (
          key TEXT PRIMARY KEY,
          value REAL NOT NULL
        )
      `);
    } catch (err) {
      // Fallback: db stays null, store/retrieve become no-ops
      this.db = null;
    }
  }

  private ensureDb(): void {
    if (!this.db) this.open();
  }

  private maybePurge(): void {
    const now = Date.now();
    if (now - this.lastPurge < PURGE_INTERVAL_MS) return;
    this.lastPurge = now;

    try {
      // Remove expired
      this.db!.exec(`DELETE FROM ccr_entries WHERE (${now} - created_at) > ttl_ms`);

      // Trim to max entries (keep newest)
      const count = (this.db!.prepare("SELECT COUNT(*) as cnt FROM ccr_entries").get() as any)?.cnt ?? 0;
      if (count > MAX_ENTRIES) {
        this.db!.exec(`
          DELETE FROM ccr_entries WHERE hash IN (
            SELECT hash FROM ccr_entries ORDER BY created_at ASC LIMIT ${count - MAX_ENTRIES}
          )
        `);
      }
    } catch {}
  }
}

/** Format a CCR marker that the LLM sees in compressed output. */
export function formatCCRMarker(hash: string, itemCount: number): string {
  return `⟨ccr:${hash} ${itemCount} items stored — use headroom_retrieve to access⟩`;
}

/** Extract CCR hash from a marker string. */
export function extractCCRHash(text: string): string | null {
  const match = text.match(/⟨ccr:([0-9a-f]{12})/);
  return match ? match[1] : null;
}
