/**
 * SmartCrusher — JSON array compression with BM25 scoring + tabular compaction
 */

import { CCRStore, formatCCRMarker, isCCRReferenceContent } from "./ccr-store.ts";
import { normalizeConcatenatedJson } from "./json-array-utils.ts";

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

function acceptIfShorter(
  original: string,
  compressed: string,
  strategy: string,
  ccrHash?: string,
): CrushResult {
  if (compressed.length >= original.length) {
    return { compressed: original, wasModified: false, strategy: "passthrough" };
  }
  return { compressed, wasModified: true, strategy, ccrHash };
}

function safeStringify(value: unknown): string {
  return JSON.stringify(value, null, 1);
}

export function smartCrush(
  content: string,
  query: string,
  config = DEFAULT_CONFIG,
  ccrStore?: CCRStore,
): CrushResult {
  if (isCCRReferenceContent(content)) {
    return { compressed: content, wasModified: false, strategy: "ccr_reference_passthrough" };
  }

  try {
    const normalized = normalizeConcatenatedJson(content);
    const jsonContent = normalized ?? content;

    let items: unknown[];
    try {
      items = JSON.parse(jsonContent);
      if (!Array.isArray(items)) return { compressed: content, wasModified: false, strategy: "passthrough" };
    } catch {
      return { compressed: content, wasModified: false, strategy: "passthrough" };
    }

    if (items.length < config.minItemsToAnalyze) {
      return { compressed: content, wasModified: false, strategy: "passthrough" };
    }

    const originalCount = items.length;
    const deduped = config.dedupIdentical ? deduplicateItems(items) : items;
    const dedupSaved = originalCount - deduped.length;

    if (deduped.length <= config.maxItemsAfterCrush) {
      if (dedupSaved > 0) {
        return acceptIfShorter(content, safeStringify(deduped), `dedup:${dedupSaved}`);
      }
      const tabular = tryTabularCompaction(deduped, config.losslessMinSavingsRatio);
      if (tabular) return acceptIfShorter(content, tabular, "tabular_compaction");
      return { compressed: content, wasModified: false, strategy: "passthrough" };
    }

    const tabular = tryTabularCompaction(deduped, config.losslessMinSavingsRatio);
    if (tabular && tabular.length < content.length * (1 - config.losslessMinSavingsRatio)) {
      return acceptIfShorter(content, tabular, "tabular_compaction");
    }

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
    const omitted = originalCount - result.length;

    if (omitted <= 0) {
      return acceptIfShorter(content, safeStringify(result), "row_drop:0");
    }

    const previewMarker = formatCCRMarker("f".repeat(24), omitted);
    const preview = ccrStore
      ? safeStringify([...result, { _ccr_dropped: previewMarker }])
      : safeStringify([...result, { _compressed: `${omitted} items omitted` }]);
    if (preview.length >= content.length) {
      return { compressed: content, wasModified: false, strategy: "passthrough" };
    }

    let ccrHash: string | undefined;
    const output = [...result];
    if (ccrStore) {
      ccrHash = ccrStore.store(content, safeStringify(result));
      output.push({ _ccr_dropped: formatCCRMarker(ccrHash, omitted) });
    } else {
      output.push({ _compressed: `${omitted} items omitted` });
    }

    return acceptIfShorter(content, safeStringify(output), `row_drop:${omitted}`, ccrHash);
  } catch {
    return { compressed: content, wasModified: false, strategy: "passthrough" };
  }
}

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
  const avgLen = 200;
  const k1 = 1.2, b = 0.75;

  let score = 0;
  for (const term of terms) {
    const tf = countOccurrences(text, term);
    if (tf === 0) continue;
    const idfVal = idf.get(term) || 0;
    const tfNorm = (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * textLen / avgLen));
    score += idfVal * tfNorm;
  }

  if (/error|fail|exception|critical/i.test(text)) score += 2.0;
  if (/warn|warning/i.test(text)) score += 1.0;

  return score;
}

function countOccurrences(text: string, term: string): number {
  let count = 0, pos = 0;
  while ((pos = text.indexOf(term, pos)) !== -1) { count++; pos += term.length; }
  return count;
}

function changePointBonus(item: unknown, items: unknown[], index: number, enabled: boolean): number {
  if (!enabled || items.length < 3) return 0;
  const current = Object.keys(typeof item === "object" && item !== null ? item : {});
  const prev = index > 0 ? Object.keys(typeof items[index - 1] === "object" && items[index - 1] !== null ? items[index - 1] as object : {}) : current;
  const next = index < items.length - 1 ? Object.keys(typeof items[index + 1] === "object" && items[index + 1] !== null ? items[index + 1] as object : {}) : current;

  const prevSim = setOverlap(current, prev);
  const nextSim = setOverlap(current, next);
  if (prevSim < 0.5 || nextSim < 0.5) return 1.5;
  return 0;
}

function setOverlap(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const setB = new Set(b);
  const intersection = a.filter((x) => setB.has(x)).length;
  return intersection / Math.max(a.length, b.length);
}

function sortedFieldKeys(record: Record<string, unknown>): string[] {
  return Object.keys(record).sort();
}

function recordsHaveIdenticalFieldSets(records: Record<string, unknown>[]): string[] | null {
  if (records.length === 0) return null;
  const reference = sortedFieldKeys(records[0]);
  for (const record of records) {
    const keys = sortedFieldKeys(record);
    if (keys.length !== reference.length || keys.some((key, index) => key !== reference[index])) {
      return null;
    }
  }
  return reference;
}

function escapeCsvCell(value: string): string {
  return value.includes(",") || value.includes("\n") || value.includes("\r") || value.includes('"')
    ? `"${value.replace(/"/g, '""')}"`
    : value;
}

function tryTabularCompaction(items: unknown[], minSavingsRatio: number): string | null {
  if (items.length < 3) return null;
  if (!items.every((item) => typeof item === "object" && item !== null && !Array.isArray(item))) return null;

  const records = items as Record<string, unknown>[];
  const fields = recordsHaveIdenticalFieldSets(records);
  if (!fields || fields.length < 2) return null;

  if (records.some((record) => fields.some((key) => record[key] === null))) return null;

  const allSimple = records.every((rec) =>
    fields.every((key) => {
      const val = rec[key];
      return typeof val === "string" || typeof val === "number" || typeof val === "boolean";
    })
  );
  if (!allSimple) return null;

  const header = fields.map((field) => escapeCsvCell(field)).join(",");
  const rows = records.map((rec) =>
    fields.map((key) => {
      const val = rec[key];
      if (typeof val === "string") return escapeCsvCell(val);
      return String(val);
    }).join(",")
  );

  const schema = `[CSV-SCHEMA] fields: ${header}\n${rows.join("\n")}`;
  const originalSize = JSON.stringify(items).length;
  const savings = 1 - schema.length / originalSize;

  if (savings < minSavingsRatio) return null;
  return schema;
}

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
