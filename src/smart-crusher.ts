/**
 * SmartCrusher — JSON array compression with BM25 scoring + tabular compaction
 * 
 * Mirrors: headroom/transforms/smart_crusher.py (Rust-backed)
 * 
 * Strategy priority:
 * 1. Deduplication (identical items)
 * 2. Lossless tabular compaction (JSON → CSV-schema)
 * 3. Lossy row-drop with BM25 scoring (keep first/last + relevant middle)
 */

import { CCRStore, formatCCRMarker } from "./ccr-store.ts";

export interface SmartCrusherConfig {
  maxItemsAfterCrush: number;
  firstFraction: number;
  lastFraction: number;
  dedupIdentical: boolean;
  minItemsToAnalyze: number;
  losslessMinSavingsRatio: number;
  preserveChangePoints: boolean;
}

export const DEFAULT_CONFIG: SmartCrusherConfig = {
  maxItemsAfterCrush: 15,
  firstFraction: 0.3,
  lastFraction: 0.15,
  dedupIdentical: true,
  minItemsToAnalyze: 5,
  losslessMinSavingsRatio: 0.15,
  preserveChangePoints: true,
};

export interface CrushResult {
  compressed: string;
  wasModified: boolean;
  strategy: string;
  ccrHash?: string;
}

export function smartCrush(
  content: string,
  query: string,
  config = DEFAULT_CONFIG,
  ccrStore?: CCRStore
): CrushResult {
  let items: unknown[];
  try {
    items = JSON.parse(content);
    if (!Array.isArray(items)) return { compressed: content, wasModified: false, strategy: "passthrough" };
  } catch {
    return { compressed: content, wasModified: false, strategy: "passthrough" };
  }

  if (items.length < config.minItemsToAnalyze) return { compressed: content, wasModified: false, strategy: "passthrough" };

  // 1. Deduplication
  const deduped = config.dedupIdentical ? deduplicateItems(items) : items;
  const dedupSaved = items.length - deduped.length;

  if (deduped.length <= config.maxItemsAfterCrush) {
    if (dedupSaved > 0) {
      const compressed = JSON.stringify(deduped, null, 1);
      return { compressed, wasModified: true, strategy: `dedup:${dedupSaved}` };
    }
    // Try lossless compaction even if under the limit
    const tabular = tryTabularCompaction(deduped, config.losslessMinSavingsRatio);
    if (tabular) return { compressed: tabular, wasModified: true, strategy: "tabular_compaction" };
    return { compressed: content, wasModified: false, strategy: "passthrough" };
  }

  // 2. Try lossless tabular compaction first
  const tabular = tryTabularCompaction(deduped, config.losslessMinSavingsRatio);
  if (tabular && tabular.length < content.length * (1 - config.losslessMinSavingsRatio)) {
    return { compressed: tabular, wasModified: true, strategy: "tabular_compaction" };
  }

  // 3. Lossy row-drop with BM25 scoring
  const maxKeep = config.maxItemsAfterCrush;
  const firstKeep = Math.max(1, Math.floor(maxKeep * config.firstFraction));
  const lastKeep = Math.max(1, Math.floor(maxKeep * config.lastFraction));
  const middleBudget = maxKeep - firstKeep - lastKeep;

  const first = deduped.slice(0, firstKeep);
  const last = deduped.slice(-lastKeep);
  const middle = deduped.slice(firstKeep, deduped.length - lastKeep);

  let selectedMiddle: unknown[];
  if (middleBudget >= middle.length) {
    selectedMiddle = middle;
  } else {
    // BM25-like scoring
    const terms = buildQueryTerms(query);
    const idf = computeIDF(middle, terms);
    const scored = middle.map((item, i) => ({
      item,
      index: i,
      score: bm25Score(item, terms, idf) + changePointBonus(item, middle, i, config.preserveChangePoints),
    }));
    scored.sort((a, b) => b.score - a.score);
    selectedMiddle = scored
      .slice(0, middleBudget)
      .sort((a, b) => a.index - b.index)
      .map((s) => s.item);
  }

  const result = [...first, ...selectedMiddle, ...last];
  const omitted = deduped.length - result.length;

  // Store in CCR if available
  let ccrHash: string | undefined;
  if (ccrStore && omitted > 0) {
    ccrHash = ccrStore.store(content, JSON.stringify(result, null, 1));
    result.push({ _ccr_dropped: formatCCRMarker(ccrHash, omitted) });
  } else if (omitted > 0) {
    result.push({ _compressed: `${omitted} items omitted` });
  }

  return {
    compressed: JSON.stringify(result, null, 1),
    wasModified: true,
    strategy: `row_drop:${omitted}`,
    ccrHash,
  };
}

// ─── BM25 Scoring ────────────────────────────────────────────────────

function buildQueryTerms(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter((t) => t.length > 2);
}

function computeIDF(items: unknown[], terms: string[]): Map<string, number> {
  const idf = new Map<string, number>();
  const N = items.length;
  for (const term of terms) {
    let df = 0;
    for (const item of items) {
      if (JSON.stringify(item).toLowerCase().includes(term)) df++;
    }
    idf.set(term, Math.log((N - df + 0.5) / (df + 0.5) + 1));
  }
  return idf;
}

function bm25Score(item: unknown, terms: string[], idf: Map<string, number>): number {
  if (terms.length === 0) return 0;
  const text = JSON.stringify(item).toLowerCase();
  const textLen = text.length;
  const avgLen = 200; // approximate
  const k1 = 1.2, b = 0.75;

  let score = 0;
  for (const term of terms) {
    const tf = countOccurrences(text, term);
    if (tf === 0) continue;
    const idfVal = idf.get(term) || 0;
    const tfNorm = (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * textLen / avgLen));
    score += idfVal * tfNorm;
  }

  // Boost error/warning items
  if (/error|fail|exception|critical/i.test(text)) score += 2.0;
  if (/warn|warning/i.test(text)) score += 1.0;

  return score;
}

function countOccurrences(text: string, term: string): number {
  let count = 0, pos = 0;
  while ((pos = text.indexOf(term, pos)) !== -1) { count++; pos += term.length; }
  return count;
}

/** Bonus for items that differ structurally from their neighbors. */
function changePointBonus(item: unknown, items: unknown[], index: number, enabled: boolean): number {
  if (!enabled || items.length < 3) return 0;
  const current = Object.keys(typeof item === "object" && item !== null ? item : {});
  const prev = index > 0 ? Object.keys(typeof items[index - 1] === "object" && items[index - 1] !== null ? items[index - 1] as object : {}) : current;
  const next = index < items.length - 1 ? Object.keys(typeof items[index + 1] === "object" && items[index + 1] !== null ? items[index + 1] as object : {}) : current;

  const prevSim = setOverlap(current, prev);
  const nextSim = setOverlap(current, next);
  if (prevSim < 0.5 || nextSim < 0.5) return 1.5; // Change point
  return 0;
}

function setOverlap(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const setB = new Set(b);
  const intersection = a.filter((x) => setB.has(x)).length;
  return intersection / Math.max(a.length, b.length);
}

// ─── Lossless Tabular Compaction (JSON → CSV-schema) ─────────────────

function tryTabularCompaction(items: unknown[], minSavingsRatio: number): string | null {
  // Only works on arrays of uniform objects
  if (items.length < 3) return null;
  if (!items.every((item) => typeof item === "object" && item !== null && !Array.isArray(item))) return null;

  const records = items as Record<string, unknown>[];

  // Find core fields (present in ≥80% of records)
  const fieldCounts = new Map<string, number>();
  for (const rec of records) {
    for (const key of Object.keys(rec)) {
      fieldCounts.set(key, (fieldCounts.get(key) || 0) + 1);
    }
  }

  const coreThreshold = records.length * 0.8;
  const coreFields = [...fieldCounts.entries()]
    .filter(([, count]) => count >= coreThreshold)
    .map(([key]) => key);

  if (coreFields.length < 2) return null;

  // Check if all values are simple (string/number/boolean/null)
  const allSimple = records.every((rec) =>
    coreFields.every((key) => {
      const val = rec[key];
      return val === null || typeof val === "string" || typeof val === "number" || typeof val === "boolean";
    })
  );

  if (!allSimple) return null;

  // Build CSV-schema format
  const header = coreFields.join(",");
  const rows = records.map((rec) =>
    coreFields.map((key) => {
      const val = rec[key];
      if (val === null) return "";
      if (typeof val === "string") {
        return val.includes(",") || val.includes("\n") || val.includes('"')
          ? `"${val.replace(/"/g, '""')}"`
          : val;
      }
      return String(val);
    }).join(",")
  );

  const schema = `[CSV-SCHEMA] fields: ${header}\n${rows.join("\n")}`;
  const originalSize = JSON.stringify(items).length;
  const savings = 1 - schema.length / originalSize;

  if (savings < minSavingsRatio) return null;
  return schema;
}

// ─── Deduplication ───────────────────────────────────────────────────

function deduplicateItems(items: unknown[]): unknown[] {
  const seen = new Set<string>();
  const result: unknown[] = [];
  for (const item of items) {
    const key = JSON.stringify(item);
    if (!seen.has(key)) {
      seen.add(key);
      result.push(item);
    }
  }
  return result;
}
