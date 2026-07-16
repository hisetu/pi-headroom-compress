/**
 * Read Lifecycle Manager
 * 
 * Detects stale and superseded Read tool outputs and replaces them with
 * compact markers. A Read becomes:
 * - STALE: when its file is subsequently edited (content is wrong)
 * - SUPERSEDED: when the same file is re-Read later (content is redundant)
 * 
 * Real-world data: 75% of Read bytes are stale or superseded.
 * - 67% stale (file edited after Read)
 * - 12% superseded (file re-Read later)
 * - Only 20% are fresh
 * 
 * Pi/OpenAI-Responses adaptation inspired by
 * headroom/transforms/read_lifecycle.py; supported message shapes differ.
 */

import { CCRStore } from "./ccr-store.ts";

// Tool names that indicate a read operation
const READ_TOOLS = new Set(["Read", "read"]);
// Tool names that indicate a mutation
const MUTATING_TOOLS = new Set(["Edit", "edit", "Write", "write"]);

type ReadState = "fresh" | "stale" | "superseded";

interface FileOperation {
  itemIndex: number;
  callId: string;
  toolName: string;
  filePath: string;
  operation: "read" | "edit";
  offset?: number;
  limit?: number;
}

interface ReadClassification {
  itemIndex: number;
  callId: string;
  filePath: string;
  state: ReadState;
}

export interface ReadLifecycleConfig {
  enabled: boolean;
  compressStale: boolean;
  compressSuperseded: boolean;
  minSizeChars: number;
}

export const DEFAULT_READ_LIFECYCLE_CONFIG: ReadLifecycleConfig = {
  enabled: true,
  compressStale: true,
  compressSuperseded: true,
  minSizeChars: 500,
};

export interface ReadLifecycleResult {
  items: unknown[];
  modified: boolean;
  readsTotal: number;
  readsStale: number;
  readsSuperseded: number;
  readsFresh: number;
  charsSaved: number;
}

interface InputItem {
  role?: string;
  type?: string;
  call_id?: string;
  name?: string;
  arguments?: string;
  output?: string;
  content?: string | unknown[];
  [key: string]: unknown;
}

/**
 * Apply Read Lifecycle management to input items.
 * 
 * Scans for function_call (read/edit/write) and function_call_output pairs,
 * classifies reads, and replaces stale/superseded ones with markers.
 */
export function applyReadLifecycle(
  items: InputItem[],
  config = DEFAULT_READ_LIFECYCLE_CONFIG,
  ccrStore?: CCRStore
): ReadLifecycleResult {
  if (!config.enabled) {
    return { items, modified: false, readsTotal: 0, readsStale: 0, readsSuperseded: 0, readsFresh: 0, charsSaved: 0 };
  }

  // Phase 1: Build file operation index from function_call items
  const fileOps = buildFileOperationIndex(items);

  // Phase 2: Classify each Read
  const classifications = classifyReads(fileOps, config);

  if (classifications.length === 0) {
    return { items, modified: false, readsTotal: 0, readsStale: 0, readsSuperseded: 0, readsFresh: 0, charsSaved: 0 };
  }

  // Phase 3: Replace stale/superseded content
  const replacements = new Map<string, ReadClassification>();
  for (const c of classifications) {
    if (c.state !== "fresh") {
      replacements.set(c.callId, c);
    }
  }

  if (replacements.size === 0) {
    return {
      items, modified: false,
      readsTotal: classifications.length,
      readsStale: 0, readsSuperseded: 0,
      readsFresh: classifications.length,
      charsSaved: 0,
    };
  }

  // Phase 4: Replace content in function_call_output items
  let charsSaved = 0;
  const newItems = items.map((item) => {
    if (item.type !== "function_call_output") return item;
    const callId = item.call_id;
    if (!callId) return item;

    const classification = replacements.get(callId);
    if (!classification) return item;

    const output = typeof item.output === "string" ? item.output : "";
    if (output.length < config.minSizeChars) return item;

    // Store in CCR before replacing
    if (ccrStore) {
      ccrStore.store(output, "", classification.filePath);
    }

    // Replace with marker
    const marker = classification.state === "stale"
      ? `[Read content stale: ${classification.filePath} was modified after this read — re-read the file for current content]`
      : `[Read content superseded: ${classification.filePath} was re-read later — use the newer read]`;

    charsSaved += output.length - marker.length;
    return { ...item, output: marker };
  });

  const staleCount = classifications.filter((c) => c.state === "stale").length;
  const supersededCount = classifications.filter((c) => c.state === "superseded").length;

  return {
    items: newItems,
    modified: charsSaved > 0,
    readsTotal: classifications.length,
    readsStale: staleCount,
    readsSuperseded: supersededCount,
    readsFresh: classifications.length - staleCount - supersededCount,
    charsSaved,
  };
}

// ─── Internal helpers ────────────────────────────────────────────────

function buildFileOperationIndex(items: InputItem[]): Map<string, FileOperation[]> {
  const ops = new Map<string, FileOperation[]>();

  // First pass: collect function_call items with their metadata
  const callMetadata = new Map<string, { name: string; filePath: string; offset?: number; limit?: number }>();

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (item.type !== "function_call") continue;

    const name = item.name || "";
    const callId = item.call_id || "";
    if (!callId || !name) continue;

    if (!READ_TOOLS.has(name) && !MUTATING_TOOLS.has(name)) continue;

    // Parse arguments to get file path
    let filePath: string | undefined;
    let offset: number | undefined;
    let limit: number | undefined;
    try {
      const args = JSON.parse(item.arguments || "{}");
      filePath = args.file_path || args.path || args.filePath;
      offset = args.offset;
      limit = args.limit;
    } catch {}

    if (!filePath) continue;
    callMetadata.set(callId, { name, filePath, offset, limit });
  }

  // Second pass: create FileOperation entries
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (item.type !== "function_call") continue;

    const callId = item.call_id || "";
    const meta = callMetadata.get(callId);
    if (!meta) continue;

    const operation: "read" | "edit" = READ_TOOLS.has(meta.name) ? "read" : "edit";
    const fileOp: FileOperation = {
      itemIndex: i,
      callId,
      toolName: meta.name,
      filePath: meta.filePath,
      operation,
      offset: meta.offset,
      limit: meta.limit,
    };

    if (!ops.has(meta.filePath)) ops.set(meta.filePath, []);
    ops.get(meta.filePath)!.push(fileOp);
  }

  return ops;
}

function classifyReads(
  fileOps: Map<string, FileOperation[]>,
  config: ReadLifecycleConfig
): ReadClassification[] {
  const classifications: ReadClassification[] = [];

  for (const [filePath, ops] of fileOps) {
    const reads = ops.filter((op) => op.operation === "read");
    const edits = ops.filter((op) => op.operation === "edit");

    for (const read of reads) {
      // Stale: any edit of this file AFTER this read?
      const isStale = config.compressStale && edits.some((e) => e.itemIndex > read.itemIndex);

      // Superseded: any later read that covers this read's range?
      const isSuperseded = config.compressSuperseded && reads.some(
        (r) => r.itemIndex > read.itemIndex && readCovers(r, read)
      );

      let state: ReadState;
      if (isStale) state = "stale";
      else if (isSuperseded) state = "superseded";
      else state = "fresh";

      classifications.push({
        itemIndex: read.itemIndex,
        callId: read.callId,
        filePath,
        state,
      });
    }
  }

  return classifications;
}

/** Check if `later` read fully covers the line range of `earlier`. */
function readCovers(later: FileOperation, earlier: FileOperation): boolean {
  // Full-file read supersedes anything
  if (later.offset == null && later.limit == null) return true;
  // If earlier was full-file, partial can't cover it
  if (earlier.offset == null && earlier.limit == null) return false;
  // Both partial: check range containment
  const laterStart = later.offset || 0;
  const laterEnd = laterStart + (later.limit || 2000);
  const earlierStart = earlier.offset || 0;
  const earlierEnd = earlierStart + (earlier.limit || 2000);
  return laterStart <= earlierStart && laterEnd >= earlierEnd;
}
