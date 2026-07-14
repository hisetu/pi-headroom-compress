/**
 * CCR (Compress-Cache-Retrieve) Store
 * 
 * When content is compressed, the original is stored here with a hash key.
 * The LLM can retrieve originals on demand via the headroom_retrieve tool.
 * 
 * Mirrors: headroom/cache/compression_store.py
 */

import { createHash } from "node:crypto";

const DEFAULT_TTL_MS = 30 * 60 * 1000; // 30 minutes
const MAX_ENTRIES = 200;

export interface CCREntry {
  hash: string;
  original: string;
  compressed: string;
  toolName?: string;
  createdAt: number;
  ttlMs: number;
  retrievalCount: number;
  lastAccessed?: number;
}

export class CCRStore {
  private entries = new Map<string, CCREntry>();
  private ttlMs: number;

  constructor(ttlMs = DEFAULT_TTL_MS) {
    this.ttlMs = ttlMs;
  }

  /** Compute a 12-char hex hash of content (same as Headroom's compute_short_hash). */
  static hash(content: string): string {
    return createHash("sha256").update(content).digest("hex").slice(0, 12);
  }

  /** Store original content and return the hash key. */
  store(original: string, compressed: string, toolName?: string): string {
    const hash = CCRStore.hash(original);

    this.entries.set(hash, {
      hash,
      original,
      compressed,
      toolName,
      createdAt: Date.now(),
      ttlMs: this.ttlMs,
      retrievalCount: 0,
    });

    // Evict expired + overflow
    this.evict();

    return hash;
  }

  /** Retrieve original content by hash. Returns null if expired or not found. */
  retrieve(hash: string): CCREntry | null {
    const entry = this.entries.get(hash);
    if (!entry) return null;
    if (Date.now() - entry.createdAt > entry.ttlMs) {
      this.entries.delete(hash);
      return null;
    }
    entry.retrievalCount++;
    entry.lastAccessed = Date.now();
    return entry;
  }

  /** Check if a hash exists and is not expired. */
  has(hash: string): boolean {
    const entry = this.entries.get(hash);
    if (!entry) return false;
    if (Date.now() - entry.createdAt > entry.ttlMs) {
      this.entries.delete(hash);
      return false;
    }
    return true;
  }

  /** Get store size. */
  get size(): number {
    return this.entries.size;
  }

  /** Get stats. */
  stats(): { size: number; totalRetrievals: number; oldestAgeMs: number } {
    let totalRetrievals = 0;
    let oldestAge = 0;
    const now = Date.now();
    for (const entry of this.entries.values()) {
      totalRetrievals += entry.retrievalCount;
      oldestAge = Math.max(oldestAge, now - entry.createdAt);
    }
    return { size: this.entries.size, totalRetrievals, oldestAgeMs: oldestAge };
  }

  /** Remove expired entries and trim to max size. */
  private evict(): void {
    const now = Date.now();

    // Remove expired
    for (const [hash, entry] of this.entries) {
      if (now - entry.createdAt > entry.ttlMs) {
        this.entries.delete(hash);
      }
    }

    // If still over capacity, remove oldest entries
    if (this.entries.size > MAX_ENTRIES) {
      const sorted = [...this.entries.entries()].sort(
        (a, b) => a[1].createdAt - b[1].createdAt
      );
      const toRemove = sorted.slice(0, this.entries.size - MAX_ENTRIES);
      for (const [hash] of toRemove) {
        this.entries.delete(hash);
      }
    }
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
