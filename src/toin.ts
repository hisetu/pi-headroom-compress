/**
 * TOIN (Tool Output Intelligence Network)
 * 
 * Observation-only learning system that records compression outcomes
 * and builds per-tool-signature intelligence:
 * - Which compression strategy works best for each tool output shape
 * - What compression ratio to expect
 * - Which fields are commonly retrieved (should be preserved)
 * 
 * Privacy: no actual data values stored. Tool names are structure hashes.
 * Field names are SHA256[:8] hashes.
 * 
 * Lightweight observation layer inspired by headroom/telemetry/toin.py;
 * it does not implement the full Headroom learning and feedback system.
 */

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

// ─── Tool Signature ──────────────────────────────────────────────────

export interface ToolSignature {
  structureHash: string;
  fieldCount: number;
  hasNestedObjects: boolean;
  hasArrays: boolean;
  maxDepth: number;
  hasErrorField: boolean;
  hasIdField: boolean;
  hasTimestampField: boolean;
}

/** Compute a structural signature from a JSON array's first items. */
export function computeSignature(items: unknown[]): ToolSignature {
  if (items.length === 0) {
    return { structureHash: "empty", fieldCount: 0, hasNestedObjects: false, hasArrays: false, maxDepth: 0, hasErrorField: false, hasIdField: false, hasTimestampField: false };
  }

  // Sample first 5 items
  const sample = items.slice(0, 5);
  const allKeys = new Set<string>();
  let hasNested = false, hasArrays = false, maxDepth = 1;
  let hasError = false, hasId = false, hasTimestamp = false;

  for (const item of sample) {
    if (typeof item !== "object" || item === null) continue;
    for (const [key, val] of Object.entries(item as Record<string, unknown>)) {
      allKeys.add(key);
      if (typeof val === "object" && val !== null) {
        if (Array.isArray(val)) hasArrays = true;
        else { hasNested = true; maxDepth = Math.max(maxDepth, 2); }
      }
      const kl = key.toLowerCase();
      if (/error|err|exception|fault/.test(kl)) hasError = true;
      if (/^id$|_id$|^key$/.test(kl)) hasId = true;
      if (/time|date|created|updated|timestamp/.test(kl)) hasTimestamp = true;
    }
  }

  // Hash the sorted field names + types
  const sortedKeys = [...allKeys].sort();
  const fingerprint = sortedKeys.join(",");
  const structureHash = createHash("sha256").update(fingerprint).digest("hex").slice(0, 24);

  return {
    structureHash,
    fieldCount: allKeys.size,
    hasNestedObjects: hasNested,
    hasArrays,
    maxDepth,
    hasErrorField: hasError,
    hasIdField: hasId,
    hasTimestampField: hasTimestamp,
  };
}

// ─── Tool Pattern ────────────────────────────────────────────────────

interface ToolPattern {
  signatureHash: string;
  totalCompressions: number;
  totalItemsSeen: number;
  totalItemsKept: number;
  avgCompressionRatio: number;
  avgTokenReduction: number;
  optimalStrategy: string;
  strategySuccessRates: Record<string, number>;
  optimalMaxItems: number;
  confidence: number;
  lastUpdated: number;
}

function newPattern(sigHash: string): ToolPattern {
  return {
    signatureHash: sigHash,
    totalCompressions: 0,
    totalItemsSeen: 0,
    totalItemsKept: 0,
    avgCompressionRatio: 0,
    avgTokenReduction: 0,
    optimalStrategy: "default",
    strategySuccessRates: {},
    optimalMaxItems: 20,
    confidence: 0,
    lastUpdated: 0,
  };
}

// ─── TOIN Store ──────────────────────────────────────────────────────

export interface TOINConfig {
  enabled: boolean;
  storagePath: string;
  autoSaveInterval: number; // ms
  minObservationsForRecommendation: number;
}

export const DEFAULT_TOIN_CONFIG: TOINConfig = {
  enabled: true,
  // Keep Pi observations separate from Headroom's Python snake_case schema.
  storagePath: join(homedir(), ".headroom", "pi-toin.json"),
  autoSaveInterval: 5 * 60 * 1000, // 5 minutes
  minObservationsForRecommendation: 10,
};

export class TOIN {
  private patterns = new Map<string, ToolPattern>();
  private config: TOINConfig;
  private dirty = false;
  private lastSave = 0;

  constructor(config = DEFAULT_TOIN_CONFIG) {
    this.config = config;
    this.load();
  }

  /** Record a compression event. */
  recordCompression(
    signature: ToolSignature,
    originalCount: number,
    compressedCount: number,
    originalChars: number,
    compressedChars: number,
    strategy: string,
  ): void {
    if (!this.config.enabled) return;

    const key = signature.structureHash;
    if (!this.patterns.has(key)) {
      this.patterns.set(key, newPattern(key));
    }

    const pattern = this.patterns.get(key)!;
    pattern.totalCompressions++;
    pattern.totalItemsSeen += originalCount;
    pattern.totalItemsKept += compressedCount;

    const n = pattern.totalCompressions;
    const compRatio = originalCount > 0 ? compressedCount / originalCount : 0;
    const tokenReduction = originalChars > 0 ? 1 - compressedChars / originalChars : 0;

    // Rolling average
    pattern.avgCompressionRatio = (pattern.avgCompressionRatio * (n - 1) + compRatio) / n;
    pattern.avgTokenReduction = (pattern.avgTokenReduction * (n - 1) + tokenReduction) / n;

    // Update strategy success rates
    if (!pattern.strategySuccessRates[strategy]) {
      pattern.strategySuccessRates[strategy] = 1.0;
    } else {
      // Small boost for each successful compression
      pattern.strategySuccessRates[strategy] = Math.min(1.0,
        pattern.strategySuccessRates[strategy] + 0.02
      );
    }

    // Update optimal strategy (highest success rate)
    const bestStrategy = Object.entries(pattern.strategySuccessRates)
      .sort((a, b) => b[1] - a[1])[0];
    if (bestStrategy) {
      pattern.optimalStrategy = bestStrategy[0];
    }

    // Update confidence
    pattern.confidence = Math.min(1.0, n / this.config.minObservationsForRecommendation);
    pattern.lastUpdated = Date.now();

    this.dirty = true;
    this.autoSave();
  }

  /** Get recommendation for a tool signature. Returns null if not enough data. */
  getRecommendation(signature: ToolSignature): {
    strategy: string;
    expectedRatio: number;
    confidence: number;
  } | null {
    const pattern = this.patterns.get(signature.structureHash);
    if (!pattern || pattern.confidence < 0.5) return null;

    return {
      strategy: pattern.optimalStrategy,
      expectedRatio: pattern.avgCompressionRatio,
      confidence: pattern.confidence,
    };
  }

  /** Get stats for display. */
  stats(): { patternCount: number; totalCompressions: number; topStrategies: Record<string, number> } {
    let totalCompressions = 0;
    const strategies: Record<string, number> = {};

    for (const pattern of this.patterns.values()) {
      const count = Number(pattern.totalCompressions);
      if (Number.isFinite(count) && count > 0) totalCompressions += count;

      const strategy = typeof pattern.optimalStrategy === "string" && pattern.optimalStrategy.trim()
        ? pattern.optimalStrategy
        : "unknown";
      strategies[strategy] = (strategies[strategy] || 0) + 1;
    }

    return { patternCount: this.patterns.size, totalCompressions, topStrategies: strategies };
  }

  /** Load from disk. */
  private load(): void {
    try {
      if (!existsSync(this.config.storagePath)) return;
      const data = JSON.parse(readFileSync(this.config.storagePath, "utf-8"));
      if (data.patterns && typeof data.patterns === "object") {
        for (const [key, val] of Object.entries(data.patterns)) {
          if (!val || typeof val !== "object") continue;
          const raw = val as Record<string, unknown>;
          const fallback = newPattern(key);
          const numberValue = (camel: string, snake: string, defaultValue: number): number => {
            const value = Number(raw[camel] ?? raw[snake]);
            return Number.isFinite(value) ? value : defaultValue;
          };
          const stringValue = (camel: string, snake: string, defaultValue: string): string => {
            const value = raw[camel] ?? raw[snake];
            return typeof value === "string" && value.trim() ? value : defaultValue;
          };
          const rates = raw.strategySuccessRates ?? raw.strategy_success_rates;

          this.patterns.set(key, {
            signatureHash: stringValue("signatureHash", "tool_signature_hash", key),
            totalCompressions: numberValue("totalCompressions", "total_compressions", fallback.totalCompressions),
            totalItemsSeen: numberValue("totalItemsSeen", "total_items_seen", fallback.totalItemsSeen),
            totalItemsKept: numberValue("totalItemsKept", "total_items_kept", fallback.totalItemsKept),
            avgCompressionRatio: numberValue("avgCompressionRatio", "avg_compression_ratio", fallback.avgCompressionRatio),
            avgTokenReduction: numberValue("avgTokenReduction", "avg_token_reduction", fallback.avgTokenReduction),
            optimalStrategy: stringValue("optimalStrategy", "optimal_strategy", fallback.optimalStrategy),
            strategySuccessRates: rates && typeof rates === "object"
              ? rates as Record<string, number>
              : fallback.strategySuccessRates,
            optimalMaxItems: numberValue("optimalMaxItems", "optimal_max_items", fallback.optimalMaxItems),
            confidence: numberValue("confidence", "confidence", fallback.confidence),
            lastUpdated: numberValue("lastUpdated", "last_updated", fallback.lastUpdated),
          });
        }
      }
    } catch {}
  }

  /** Save to disk. */
  save(): void {
    if (!this.dirty) return;
    try {
      const dir = dirname(this.config.storagePath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      const data = {
        version: 1,
        savedAt: new Date().toISOString(),
        patterns: Object.fromEntries(this.patterns),
      };
      writeFileSync(this.config.storagePath, JSON.stringify(data, null, 2));
      this.dirty = false;
      this.lastSave = Date.now();
    } catch {}
  }

  /** Auto-save if interval elapsed. */
  private autoSave(): void {
    if (Date.now() - this.lastSave > this.config.autoSaveInterval) {
      this.save();
    }
  }
}
