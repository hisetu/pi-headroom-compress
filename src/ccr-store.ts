/**
 * CCR (Compress-Cache-Retrieve) Store
 *
 * When content is compressed, the original is stored here with a hash key.
 * Users can preview originals on demand with `/headroom-retrieve <hash>` (first 2,000 chars).
 *
 * Storage: SQLite at ~/.headroom/pi-ccr-store.db (separate from Python Headroom).
 * Survives process restarts and /reload.
 *
 * Inspired by headroom/cache/compression_store.py + backends/sqlite.py;
 * this is a smaller Pi-specific schema and feature set.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const DEFAULT_TTL_MS = 30 * 60 * 1000; // 30 minutes
const MAX_ENTRIES = 1000;
const PURGE_INTERVAL_MS = 60_000; // purge expired rows at most once per minute

export interface SavingsEvent {
  timestamp: number;
  model: string;
  provider: string;
  tokensBefore: number;
  tokensAfter: number;
  tokensSaved: number;
  costUsd: number;
  inputCostPer1M: number;
  pricingSource: string;
}

export interface GlobalSavings {
  tokensSaved: number;
  costUsd: number;
  eventCount: number;
}

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

  /** Compute Headroom's default 24-char (96-bit) SHA-256 cache key. */
  static hash(content: string): string {
    return createHash("sha256").update(content).digest("hex").slice(0, 24);
  }

  /** Store original content and return the hash key. */
  store(original: string, compressed: string, toolName?: string, strategy?: string): string {
    const hash = CCRStore.hash(original);
    const now = Date.now();

    this.ensureDb();

    const existing = this.db!.prepare(
      "SELECT created_at, ttl_ms FROM ccr_entries WHERE hash = ?"
    ).get(hash) as { created_at: number; ttl_ms: number } | undefined;

    if (existing && now - existing.created_at > existing.ttl_ms) {
      this.db!.prepare("DELETE FROM ccr_entries WHERE hash = ?").run(hash);
    } else if (existing) {
      this.db!.prepare(`
        UPDATE ccr_entries
        SET original = ?, compressed = ?, strategy = ?, tool_name = ?
        WHERE hash = ?
      `).run(original, compressed, strategy ?? null, toolName ?? null, hash);
      this.maybePurge();
      return hash;
    }

    this.db!.prepare(
      `INSERT INTO ccr_entries (hash, original, compressed, strategy, tool_name, created_at, ttl_ms, retrieval_count, last_accessed)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, NULL)`
    ).run(hash, original, compressed, strategy ?? null, toolName ?? null, now, this.ttlMs);

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

  /** Append one priced compression event. Cost is fixed at write time. */
  recordSavingsEvent(event: SavingsEvent): void {
    if (event.tokensSaved <= 0 || event.costUsd < 0) return;
    this.ensureDb();
    this.db!.prepare(`
      INSERT INTO savings_events (
        timestamp, model, provider, tokens_before, tokens_after,
        tokens_saved, cost_usd, input_cost_per_1m, pricing_source
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      event.timestamp,
      event.model,
      event.provider,
      event.tokensBefore,
      event.tokensAfter,
      event.tokensSaved,
      event.costUsd,
      event.inputCostPer1M,
      event.pricingSource,
    );
  }

  /** Aggregate append-only savings events across every Pi session. */
  getGlobalSavings(): GlobalSavings {
    this.ensureDb();
    const row = this.db!.prepare(`
      SELECT COUNT(*) AS event_count,
             COALESCE(SUM(tokens_saved), 0) AS tokens_saved,
             COALESCE(SUM(cost_usd), 0) AS cost_usd
      FROM savings_events
    `).get() as any;
    return {
      tokensSaved: Number(row?.tokens_saved) || 0,
      costUsd: Number(row?.cost_usd) || 0,
      eventCount: Number(row?.event_count) || 0,
    };
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
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS savings_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          timestamp REAL NOT NULL,
          model TEXT NOT NULL,
          provider TEXT NOT NULL,
          tokens_before INTEGER NOT NULL,
          tokens_after INTEGER NOT NULL,
          tokens_saved INTEGER NOT NULL,
          cost_usd REAL NOT NULL,
          input_cost_per_1m REAL NOT NULL,
          pricing_source TEXT NOT NULL
        )
      `);
      this.db.exec("CREATE INDEX IF NOT EXISTS idx_savings_timestamp ON savings_events (timestamp)");
      this.migrateLegacySavings();
    } catch (err) {
      // Fallback: db stays null, store/retrieve become no-ops
      this.db = null;
    }
  }

  private ensureDb(): void {
    if (!this.db) this.open();
  }

  /** Convert the previous fixed-rate saved_chars counter exactly once. */
  private migrateLegacySavings(): void {
    try {
      const migrated = this.db!.prepare(
        "SELECT value FROM global_stats WHERE key = ?"
      ).get("savings_ledger_migrated") as any;
      if (Number(migrated?.value) === 1) return;

      const legacy = this.db!.prepare(
        "SELECT value FROM global_stats WHERE key = ?"
      ).get("saved_chars") as any;
      const chars = Number(legacy?.value);
      if (Number.isFinite(chars) && chars > 0) {
        const tokens = Math.ceil(chars / 4);
        this.db!.prepare(`
          INSERT INTO savings_events (
            timestamp, model, provider, tokens_before, tokens_after,
            tokens_saved, cost_usd, input_cost_per_1m, pricing_source
          ) VALUES (?, 'unknown', 'unknown', ?, 0, ?, ?, 3, 'legacy-fallback')
        `).run(Date.now(), tokens, tokens, tokens * 3 / 1_000_000);
      }
      this.db!.prepare(
        "INSERT OR REPLACE INTO global_stats (key, value) VALUES (?, 1)"
      ).run("savings_ledger_migrated");
    } catch {}
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

/** Format a CCR preview marker that the LLM sees in compressed output. */
export function formatCCRMarker(hash: string, itemCount: number): string {
  return `⟨ccr:${hash} ${itemCount} items stored — ask the user to run /headroom-retrieve ${hash} for a preview⟩`;
}

const CCR_HASH_CAPTURE = "(?:[0-9a-f]{12}|[0-9a-f]{24})";
const LEGACY_CCR_MARKER = `⟨ccr:${CCR_HASH_CAPTURE} \\d+ items stored — use headroom_retrieve to access⟩`;
const CURRENT_CCR_MARKER = `⟨ccr:(${CCR_HASH_CAPTURE}) \\d+ items stored — ask the user to run /headroom-retrieve \\1(?: for a preview)?⟩`;

/** True when a string is an exact current or legacy Pi CCR marker value. */
export function isExactCCRMarkerValue(value: string): boolean {
  return new RegExp(`^(?:${LEGACY_CCR_MARKER}|${CURRENT_CCR_MARKER})$`).test(value);
}

/** Extract CCR hash from a marker string. */
export function extractCCRHash(text: string): string | null {
  const match = text.match(new RegExp(`⟨ccr:(${CCR_HASH_CAPTURE})(?![0-9a-f])`));
  return match ? match[1] : null;
}

/** Validate a user-supplied CCR hash for retrieval commands. */
export function isValidCCRHash(hash: string): boolean {
  return /^(?:[0-9a-f]{12}|[0-9a-f]{24})$/.test(hash);
}

function isSmartCrusherCCROutput(text: string): boolean {
  if (!text.includes("_ccr_dropped")) return false;
  const trimmed = text.trim();
  try {
    const parsed = JSON.parse(trimmed);
    if (!Array.isArray(parsed)) return false;
    return parsed.some((item) =>
      typeof item === "object" &&
      item !== null &&
      !Array.isArray(item) &&
      typeof (item as Record<string, unknown>)._ccr_dropped === "string" &&
      isExactCCRMarkerValue(String((item as Record<string, unknown>)._ccr_dropped))
    );
  } catch {
    return false;
  }
}

const STALE_READ_MARKER = /^\[Read content stale: .+ was modified after this read —(?: preview \/headroom-retrieve (?:[0-9a-f]{12}|[0-9a-f]{24}) or)? re-read the file for current content\]$/s;
const SUPERSEDED_READ_MARKER = /^\[Read content superseded: .+ was re-read later —(?: preview \/headroom-retrieve (?:[0-9a-f]{12}|[0-9a-f]{24}) or)? use the newer read\]$/s;

/** True when content is already a Pi CCR reference or an exact read-lifecycle marker. */
export function isCCRReferenceContent(text: string): boolean {
  const trimmed = text.trim();
  if (isExactCCRMarkerValue(trimmed)) return true;
  if (STALE_READ_MARKER.test(trimmed) || SUPERSEDED_READ_MARKER.test(trimmed)) return true;
  if (trimmed.includes("_ccr_dropped") || trimmed.includes("⟨ccr:")) {
    return isSmartCrusherCCROutput(trimmed);
  }
  return false;
}

/** Extract an exact CCR marker to preserve when output size must be capped. */
export function extractPreservableCCRMarker(text: string): string | null {
  const trimmed = text.trim();
  if (isExactCCRMarkerValue(trimmed)) return trimmed;
  if (!trimmed.includes("_ccr_dropped")) return null;
  try {
    const parsed = JSON.parse(trimmed);
    if (!Array.isArray(parsed)) return null;
    for (const item of parsed) {
      if (
        typeof item === "object" &&
        item !== null &&
        !Array.isArray(item) &&
        typeof (item as Record<string, unknown>)._ccr_dropped === "string"
      ) {
        const marker = String((item as Record<string, unknown>)._ccr_dropped);
        if (isExactCCRMarkerValue(marker)) return marker;
      }
    }
  } catch {}
  return null;
}

export function capCompressedOutput(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const marker = extractPreservableCCRMarker(text);
  if (marker) return marker;

  let annotation = "";
  let keepChars = Math.max(0, maxChars);
  for (let attempt = 0; attempt < 3; attempt++) {
    const omitted = text.length - keepChars;
    annotation = `\n⟨${omitted} chars omitted⟩\n`;
    keepChars = Math.max(0, maxChars - annotation.length);
  }
  const firstHalf = Math.ceil(keepChars / 2);
  const secondHalf = Math.floor(keepChars / 2);
  return text.slice(0, firstHalf) + annotation + text.slice(text.length - secondHalf);
}
