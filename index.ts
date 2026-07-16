import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { CCRStore, formatCCRMarker, extractCCRHash } from "./src/ccr-store.ts";
import { smartCrush, DEFAULT_CONFIG as CRUSHER_CONFIG } from "./src/smart-crusher.ts";
import { analyzeCacheAlignment } from "./src/cache-aligner.ts";
import { compressCode as astCompressCode } from "./src/code-compressor.ts";
import { applyReadLifecycle, DEFAULT_READ_LIFECYCLE_CONFIG } from "./src/read-lifecycle.ts";
import { shapeOutput, DEFAULT_OUTPUT_SHAPER_CONFIG } from "./src/output-shaper.ts";
import { TOIN, DEFAULT_TOIN_CONFIG, computeSignature } from "./src/toin.ts";
import { kompressText, isKompressAvailable, DEFAULT_KOMPRESS_CONFIG } from "./src/kompress.ts";

// ═══════════════════════════════════════════════════════════════════════
// HEADROOM-COMPRESS: Pure TypeScript context compression extension
// Implements Headroom-equivalent algorithms without external dependencies
// ═══════════════════════════════════════════════════════════════════════

// Global instances
const ccrStore = new CCRStore();
const toin = new TOIN();
const kompressConfig = { ...DEFAULT_KOMPRESS_CONFIG };

// ─── Content Type Detection (port of content_detector.py) ────────────

type ContentType = "json_array" | "source_code" | "search" | "build" | "diff" | "html" | "tabular" | "text";

interface DetectionResult {
  type: ContentType;
  confidence: number;
  metadata: Record<string, unknown>;
}

function detectContentType(content: string): DetectionResult {
  if (!content?.trim()) return { type: "text", confidence: 0, metadata: {} };

  const trimmed = content.trim();

  // 1. JSON array (highest priority — SmartCrusher target)
  if (trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        const isDictArray = parsed.length > 0 && parsed.every((item) => typeof item === "object" && item !== null && !Array.isArray(item));
        return { type: "json_array", confidence: isDictArray ? 1.0 : 0.8, metadata: { itemCount: parsed.length, isDictArray } };
      }
    } catch {}
  }

  const lines = content.split("\n");
  const sampleLines = lines.slice(0, 200);

  // 2. Git diff
  const diffScore = detectDiff(sampleLines);
  if (diffScore >= 0.7) return { type: "diff", confidence: diffScore, metadata: {} };

  // 3. Search results (file:line: pattern)
  const searchScore = detectSearch(sampleLines);
  if (searchScore >= 0.6) return { type: "search", confidence: searchScore, metadata: {} };

  // 4. Build/log output
  const logScore = detectLog(sampleLines);
  if (logScore >= 0.5) return { type: "build", confidence: logScore, metadata: {} };

  // 5. Source code
  const codeResult = detectCode(sampleLines);
  if (codeResult.confidence >= 0.5) return codeResult;

  return { type: "text", confidence: 0.5, metadata: {} };
}

const DIFF_HEADER_RE = /^(diff --git|diff --combined |diff --cc |--- a\/|@@\s+-\d+,\d+\s+\+\d+,\d+\s+@@)/;
const DIFF_CHANGE_RE = /^[+-][^+-]/;

function detectDiff(lines: string[]): number {
  let headers = 0, changes = 0;
  for (const line of lines) {
    if (DIFF_HEADER_RE.test(line)) headers++;
    if (DIFF_CHANGE_RE.test(line)) changes++;
  }
  if (headers === 0) return 0;
  return Math.min(1.0, 0.5 + headers * 0.2 + changes * 0.01);
}

const SEARCH_RE = /^[^\s:]+:\d+:/;

function detectSearch(lines: string[]): number {
  const nonEmpty = lines.filter((l) => l.trim());
  if (nonEmpty.length === 0) return 0;
  const matches = nonEmpty.filter((l) => SEARCH_RE.test(l)).length;
  const ratio = matches / nonEmpty.length;
  if (ratio < 0.3) return 0;
  return Math.min(1.0, 0.4 + ratio * 0.6);
}

const LOG_PATTERNS = [
  /\b(ERROR|FAIL|FAILED|FATAL|CRITICAL)\b/i,
  /\b(WARN|WARNING)\b/i,
  /\b(INFO|DEBUG|TRACE)\b/i,
  /^\s*\d{4}-\d{2}-\d{2}/,
  /^\s*\[\d{2}:\d{2}:\d{2}\]/,
  /^={3,}|^-{3,}/,
  /^\s*PASSED|^\s*FAILED|^\s*SKIPPED/,
  /Traceback \(most recent call last\)/,
  /^\w*(Error|Exception):/,
  /^\s*at\s+[\w.$]+\(/,
];

function detectLog(lines: string[]): number {
  const nonEmpty = lines.filter((l) => l.trim());
  if (nonEmpty.length === 0) return 0;
  let matches = 0, errors = 0;
  for (const line of nonEmpty) {
    for (let i = 0; i < LOG_PATTERNS.length; i++) {
      if (LOG_PATTERNS[i].test(line)) {
        matches++;
        if (i < 2) errors++;
        break;
      }
    }
  }
  const ratio = matches / nonEmpty.length;
  if (ratio < 0.1) return 0;
  return Math.min(1.0, 0.3 + ratio * 0.5 + errors * 0.05);
}

const CODE_PATTERNS: Record<string, RegExp[]> = {
  python: [/^\s*(def|class|import|from|async def)\s+\w+/, /^\s*@\w+/, /^\s*if __name__\s*==/],
  javascript: [/^\s*(function|const|let|var|class|import|export)\s+/, /^\s*module\.exports/],
  typescript: [/^\s*(interface|type|enum|namespace)\s+\w+/, /:\s*(string|number|boolean|any|void)\b/],
  go: [/^\s*(func|type|package|import)\s+/],
  rust: [/^\s*(fn|struct|enum|impl|mod|use|pub)\s+/, /^\s*#\[/],
};

function detectCode(lines: string[]): DetectionResult {
  const scores: Record<string, number> = {};
  for (const line of lines) {
    for (const [lang, patterns] of Object.entries(CODE_PATTERNS)) {
      for (const p of patterns) {
        if (p.test(line)) { scores[lang] = (scores[lang] || 0) + 1; break; }
      }
    }
  }
  const best = Object.entries(scores).sort((a, b) => b[1] - a[1])[0];
  if (!best || best[1] < 3) return { type: "source_code", confidence: 0, metadata: {} };
  const nonEmpty = lines.filter((l) => l.trim()).length;
  const ratio = best[1] / Math.max(nonEmpty, 1);
  return { type: "source_code", confidence: Math.min(1.0, 0.4 + ratio * 0.4 + best[1] * 0.02), metadata: { language: best[0] } };
}

// ─── SmartCrusher (JSON array compression) ───────────────────────────

interface SmartCrusherConfig {
  maxItemsAfterCrush: number;
  firstFraction: number;
  lastFraction: number;
  dedupIdentical: boolean;
  minItemsToAnalyze: number;
}

const DEFAULT_CRUSHER_CONFIG: SmartCrusherConfig = {
  maxItemsAfterCrush: 15,
  firstFraction: 0.3,
  lastFraction: 0.15,
  dedupIdentical: true,
  minItemsToAnalyze: 5,
};

function smartCrushJsonArray(content: string, query: string, config = DEFAULT_CRUSHER_CONFIG): { compressed: string; wasModified: boolean } {
  let items: unknown[];
  try {
    items = JSON.parse(content);
    if (!Array.isArray(items)) return { compressed: content, wasModified: false };
  } catch {
    return { compressed: content, wasModified: false };
  }

  if (items.length <= config.minItemsToAnalyze) return { compressed: content, wasModified: false };
  if (items.length <= config.maxItemsAfterCrush) {
    // Still try dedup
    if (config.dedupIdentical) {
      const deduped = deduplicateItems(items);
      if (deduped.length < items.length) {
        return { compressed: JSON.stringify(deduped, null, 1), wasModified: true };
      }
    }
    return { compressed: content, wasModified: false };
  }

  // Dedup first
  let working = config.dedupIdentical ? deduplicateItems(items) : items;
  if (working.length <= config.maxItemsAfterCrush) {
    return { compressed: JSON.stringify(working, null, 1), wasModified: working.length < items.length };
  }

  // Keep first N + last M + scored middle
  const maxKeep = config.maxItemsAfterCrush;
  const firstKeep = Math.max(1, Math.floor(maxKeep * config.firstFraction));
  const lastKeep = Math.max(1, Math.floor(maxKeep * config.lastFraction));
  const middleBudget = maxKeep - firstKeep - lastKeep;

  const first = working.slice(0, firstKeep);
  const last = working.slice(-lastKeep);
  const middle = working.slice(firstKeep, -lastKeep);

  let selectedMiddle: unknown[];
  if (middleBudget >= middle.length) {
    selectedMiddle = middle;
  } else {
    // Score middle items by relevance to query
    const scored = middle.map((item, i) => ({
      item,
      score: scoreItem(item, query, i, middle.length),
    }));
    scored.sort((a, b) => b.score - a.score);
    selectedMiddle = scored.slice(0, middleBudget).sort((a, b) => middle.indexOf(a.item) - middle.indexOf(b.item)).map((s) => s.item);
  }

  const result = [...first, ...selectedMiddle, ...last];
  const omitted = items.length - result.length;
  if (omitted > 0) {
    (result as unknown[]).push({ _compressed: `${omitted} items omitted by headroom-compress` });
  }

  return { compressed: JSON.stringify(result, null, 1), wasModified: true };
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

function scoreItem(item: unknown, query: string, position: number, total: number): number {
  let score = 0;
  const text = JSON.stringify(item).toLowerCase();

  // BM25-like term matching against query
  if (query) {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    for (const term of terms) {
      if (text.includes(term)) score += 0.3;
    }
  }

  // Error/warning indicators score higher
  if (/error|fail|exception|critical/i.test(text)) score += 0.5;
  if (/warn|warning/i.test(text)) score += 0.2;

  // Position-based recency (recent items slightly preferred)
  score += (position / total) * 0.1;

  return score;
}

// ─── Log/Build Output Compressor ─────────────────────────────────────

interface LogConfig {
  maxErrors: number;
  maxWarnings: number;
  maxStackTraces: number;
  stackTraceMaxLines: number;
  errorContextLines: number;
  maxTotalLines: number;
  dedupeWarnings: boolean;
}

const DEFAULT_LOG_CONFIG: LogConfig = {
  maxErrors: 10,
  maxWarnings: 5,
  maxStackTraces: 3,
  stackTraceMaxLines: 20,
  errorContextLines: 3,
  maxTotalLines: 50,
  dedupeWarnings: true,
};

type LogLevel = "error" | "warn" | "info" | "debug" | "trace" | "unknown";

interface ScoredLine {
  index: number;
  content: string;
  level: LogLevel;
  isStackTrace: boolean;
  isSummary: boolean;
  score: number;
}

function compressLog(content: string, config = DEFAULT_LOG_CONFIG): string {
  const lines = content.split("\n");
  if (lines.length <= config.maxTotalLines) return content;

  const scored = scoreLogLines(lines);
  const selected = selectLogLines(scored, config);
  const selectedIndices = new Set(selected.map((l) => l.index));

  // Add context around errors
  const withContext = new Set(selectedIndices);
  for (const idx of selectedIndices) {
    if (scored[idx]?.level === "error") {
      for (let i = Math.max(0, idx - config.errorContextLines); i <= Math.min(lines.length - 1, idx + config.errorContextLines); i++) {
        withContext.add(i);
      }
    }
  }

  const outputLines: string[] = [];
  let lastIdx = -1;
  const sortedIndices = [...withContext].sort((a, b) => a - b);

  for (const idx of sortedIndices) {
    if (lastIdx >= 0 && idx - lastIdx > 1) {
      const gap = idx - lastIdx - 1;
      outputLines.push(`  ... (${gap} lines omitted)`);
    }
    outputLines.push(lines[idx]);
    lastIdx = idx;
  }

  const omitted = lines.length - sortedIndices.length;
  if (omitted > 0) {
    const errorCount = scored.filter((l) => l.level === "error").length;
    const warnCount = scored.filter((l) => l.level === "warn").length;
    outputLines.push(`[${omitted} lines omitted | ${errorCount} errors, ${warnCount} warnings in original]`);
  }

  return outputLines.join("\n");
}

function scoreLogLines(lines: string[]): ScoredLine[] {
  const ERROR_RE = /\b(ERROR|FAIL|FAILED|FATAL|CRITICAL)\b/i;
  const WARN_RE = /\b(WARN|WARNING)\b/i;
  const INFO_RE = /\b(INFO)\b/i;
  const DEBUG_RE = /\b(DEBUG|TRACE)\b/i;
  const STACK_RE = /^\s*(Traceback|File "|at\s+[\w.$]+\(|-->|^\s*\d+:\s+0x)/;
  const SUMMARY_RE = /^(={3,}|-{3,}|\d+ (passed|failed)|Tests?:?\s+\d+|Total|Summary|Build.*(?:succeeded|failed))/i;

  let inStack = false;
  return lines.map((content, index) => {
    let level: LogLevel = "unknown";
    if (ERROR_RE.test(content)) level = "error";
    else if (WARN_RE.test(content)) level = "warn";
    else if (INFO_RE.test(content)) level = "info";
    else if (DEBUG_RE.test(content)) level = "debug";

    const isStackTrace = STACK_RE.test(content) || (inStack && /^\s+/.test(content) && content.trim().length > 0);
    if (STACK_RE.test(content)) inStack = true;
    else if (!content.trim() || !/^\s/.test(content)) inStack = false;

    const isSummary = SUMMARY_RE.test(content);

    let score = level === "error" ? 1.0 : level === "warn" ? 0.5 : level === "info" ? 0.1 : 0.05;
    if (isStackTrace) score += 0.3;
    if (isSummary) score += 0.4;

    return { index, content, level, isStackTrace, isSummary, score: Math.min(1.0, score) };
  });
}

function selectLogLines(scored: ScoredLine[], config: LogConfig): ScoredLine[] {
  const errors = scored.filter((l) => l.level === "error").slice(0, config.maxErrors);
  let warnings = scored.filter((l) => l.level === "warn");
  if (config.dedupeWarnings) warnings = dedupeLines(warnings);
  warnings = warnings.slice(0, config.maxWarnings);

  const stacks: ScoredLine[][] = [];
  let currentStack: ScoredLine[] = [];
  for (const line of scored) {
    if (line.isStackTrace) {
      currentStack.push(line);
    } else if (currentStack.length > 0) {
      stacks.push(currentStack.slice(0, config.stackTraceMaxLines));
      currentStack = [];
    }
  }
  if (currentStack.length > 0) stacks.push(currentStack.slice(0, config.stackTraceMaxLines));

  const summaries = scored.filter((l) => l.isSummary);

  const selected = [...errors, ...warnings, ...stacks.slice(0, config.maxStackTraces).flat(), ...summaries];
  const unique = [...new Map(selected.map((l) => [l.index, l])).values()];

  if (unique.length > config.maxTotalLines) {
    unique.sort((a, b) => b.score - a.score);
    return unique.slice(0, config.maxTotalLines);
  }
  return unique;
}

function dedupeLines(lines: ScoredLine[]): ScoredLine[] {
  const seen = new Set<string>();
  return lines.filter((line) => {
    const normalized = line.content.replace(/\d+/g, "N").replace(/0x[0-9a-f]+/gi, "ADDR").replace(/\/[\w/]+\//g, "/PATH/");
    if (seen.has(normalized)) return false;
    seen.add(normalized);
    return true;
  });
}

// ─── Diff Compressor ─────────────────────────────────────────────────

interface DiffConfig {
  maxContextLines: number;
  maxHunksPerFile: number;
  maxFiles: number;
}

const DEFAULT_DIFF_CONFIG: DiffConfig = {
  maxContextLines: 2,
  maxHunksPerFile: 10,
  maxFiles: 20,
};

function compressDiff(content: string, config = DEFAULT_DIFF_CONFIG): string {
  const lines = content.split("\n");
  if (lines.length < 50) return content; // too small to compress

  const files = parseDiffFiles(lines);
  if (files.length === 0) return content;

  const kept = files.slice(0, config.maxFiles);
  const outputLines: string[] = [];

  for (const file of kept) {
    outputLines.push(...file.header);
    let hunksKept = 0;
    for (const hunk of file.hunks) {
      if (hunksKept >= config.maxHunksPerFile) {
        outputLines.push(`  ... (${file.hunks.length - hunksKept} more hunks omitted)`);
        break;
      }
      // Keep hunk header + changed lines + limited context
      outputLines.push(hunk.header);
      let contextCount = 0;
      for (const line of hunk.lines) {
        if (line.startsWith("+") || line.startsWith("-")) {
          outputLines.push(line);
          contextCount = 0;
        } else {
          contextCount++;
          if (contextCount <= config.maxContextLines) {
            outputLines.push(line);
          }
        }
      }
      hunksKept++;
    }
  }

  if (files.length > config.maxFiles) {
    outputLines.push(`\n... (${files.length - config.maxFiles} more files omitted)`);
  }

  return outputLines.join("\n");
}

interface DiffFile {
  header: string[];
  hunks: { header: string; lines: string[] }[];
}

function parseDiffFiles(lines: string[]): DiffFile[] {
  const files: DiffFile[] = [];
  let current: DiffFile | null = null;
  let currentHunk: { header: string; lines: string[] } | null = null;

  for (const line of lines) {
    if (line.startsWith("diff --git") || line.startsWith("diff --combined") || line.startsWith("diff --cc")) {
      if (current) files.push(current);
      current = { header: [line], hunks: [] };
      currentHunk = null;
    } else if (current && !currentHunk && (line.startsWith("---") || line.startsWith("+++") || line.startsWith("index ") || line.startsWith("new file") || line.startsWith("deleted file") || line.startsWith("rename"))) {
      current.header.push(line);
    } else if (/^@@/.test(line)) {
      if (currentHunk && current) current.hunks.push(currentHunk);
      currentHunk = { header: line, lines: [] };
    } else if (currentHunk) {
      currentHunk.lines.push(line);
    }
  }
  if (currentHunk && current) current.hunks.push(currentHunk);
  if (current) files.push(current);

  return files;
}

// ─── Code Compressor ─────────────────────────────────────────────────

function compressCode(content: string): string {
  const lines = content.split("\n");
  if (lines.length < 30) return content; // too small

  const result: string[] = [];
  let blankCount = 0;
  let inBlockComment = false;

  for (const line of lines) {
    const trimmed = line.trim();

    // Collapse multiple blank lines to one
    if (!trimmed) {
      blankCount++;
      if (blankCount <= 1) result.push(line);
      continue;
    }
    blankCount = 0;

    // Skip block comments
    if (trimmed.startsWith("/*") && !trimmed.includes("*/")) { inBlockComment = true; continue; }
    if (inBlockComment) { if (trimmed.includes("*/")) inBlockComment = false; continue; }

    // Skip single-line comments (but keep shebangs and important comments)
    if ((trimmed.startsWith("//") || trimmed.startsWith("#")) && !trimmed.startsWith("#!") && !trimmed.startsWith("# type:") && !/TODO|FIXME|HACK|NOTE|BUG/i.test(trimmed)) {
      continue;
    }

    result.push(line);
  }

  return result.join("\n");
}

// ─── Search Results Compressor ───────────────────────────────────────

function compressSearch(content: string, maxResults = 20): string {
  const lines = content.split("\n");
  if (lines.length <= maxResults) return content;

  // Group by file
  const fileGroups = new Map<string, string[]>();
  for (const line of lines) {
    const match = line.match(/^([^:]+):\d+:/);
    if (match) {
      const file = match[1];
      if (!fileGroups.has(file)) fileGroups.set(file, []);
      fileGroups.get(file)!.push(line);
    }
  }

  // Keep first few results per file, up to maxResults total
  const result: string[] = [];
  const maxPerFile = Math.max(3, Math.floor(maxResults / Math.max(fileGroups.size, 1)));

  for (const [, fileLines] of fileGroups) {
    result.push(...fileLines.slice(0, maxPerFile));
    if (fileLines.length > maxPerFile) {
      result.push(`  ... (${fileLines.length - maxPerFile} more matches in this file)`);
    }
    if (result.length >= maxResults) break;
  }

  if (lines.length > result.length) {
    result.push(`\n[${lines.length - result.length} more results omitted | ${fileGroups.size} files total]`);
  }

  return result.join("\n");
}

// ─── Main Compression Router ─────────────────────────────────────────

export function compressContent(content: string, query = ""): { compressed: string; wasModified: boolean; strategy: string } {
  if (!content || content.length < 500) return { compressed: content, wasModified: false, strategy: "passthrough" };

  const detection = detectContentType(content);

  switch (detection.type) {
    case "json_array": {
      const result = smartCrush(content, query, CRUSHER_CONFIG, ccrStore);
      return { compressed: result.compressed, wasModified: result.wasModified, strategy: result.strategy };
    }
    case "build":
      const logResult = compressLog(content);
      return { compressed: logResult, wasModified: logResult !== content, strategy: "log_compressor" };
    case "diff":
      const diffResult = compressDiff(content);
      return { compressed: diffResult, wasModified: diffResult !== content, strategy: "diff_compressor" };
    case "source_code": {
      try {
        const astResult = astCompressCode(content, query);
        if (astResult.wasModified) {
          return { compressed: astResult.compressed, wasModified: true, strategy: astResult.strategy };
        }
      } catch {}
      // Fallback to regex-based
      const codeResult = compressCode(content);
      return { compressed: codeResult, wasModified: codeResult !== content, strategy: "code_compressor_regex" };
    }
    case "search":
      const searchResult = compressSearch(content);
      return { compressed: searchResult, wasModified: searchResult !== content, strategy: "search_compressor" };
    default: {
      // Plain text: try Kompress ML first
      if (kompressConfig.enabled && content.length >= kompressConfig.minCharsToCompress) {
        const kr = kompressText(content, kompressConfig);
        if (kr.wasModified) {
          return { compressed: kr.compressed, wasModified: true, strategy: "kompress_ml" };
        }
      }
      // Fallback: mid-truncate if very large
      if (content.length > 16000) {
        const half = 7000;
        const compressed = content.slice(0, half) + `\n\n⟨${(content.length - half * 2).toLocaleString()} chars omitted by headroom-compress⟩\n\n` + content.slice(-half);
        return { compressed, wasModified: true, strategy: "text_truncate" };
      }
      return { compressed: content, wasModified: false, strategy: "passthrough" };
    }
  }
}

// ─── ANSI / Cleanup utilities ────────────────────────────────────────

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
}

function deduplicateConsecutiveLines(text: string): string {
  const lines = text.split("\n");
  if (lines.length < 10) return text;
  const result: string[] = [];
  let lastLine = "", dupeCount = 0;
  for (const line of lines) {
    if (line === lastLine) { dupeCount++; }
    else {
      if (dupeCount > 2) result.push(`  ... (${dupeCount} identical lines omitted)`);
      else for (let i = 0; i < dupeCount; i++) result.push(lastLine);
      result.push(line);
      dupeCount = 0;
      lastLine = line;
    }
  }
  if (dupeCount > 2) result.push(`  ... (${dupeCount} identical lines omitted)`);
  else for (let i = 0; i < dupeCount; i++) result.push(lastLine);
  return result.join("\n");
}

// ─── Extension Entry Point ───────────────────────────────────────────

interface InputItem {
  role?: string; type?: string; content?: string | unknown[]; output?: string;
  phase?: string; [key: string]: unknown;
}
interface ContentBlock { type?: string; text?: string; [key: string]: unknown; }
interface RequestPayload { model?: string; input?: InputItem[]; [key: string]: unknown; }

interface Stats {
  enabled: boolean;
  maxOutputChars: number;
  maxAssistantChars: number;
  requestCount: number;
  compressedCount: number;
  totalOriginalChars: number;
  totalCompressedChars: number;
  strategyCounts: Record<string, number>;
}

function getItemText(item: InputItem): string {
  if (typeof item.output === "string") return item.output;
  if (typeof item.content === "string") return item.content;
  if (Array.isArray(item.content)) {
    return (item.content as ContentBlock[]).map((b) => b.text || "").join("\n");
  }
  return "";
}

function setItemText(item: InputItem, text: string): InputItem {
  if (typeof item.output === "string") return { ...item, output: text };
  if (typeof item.content === "string") return { ...item, content: text };
  if (Array.isArray(item.content)) {
    const newContent = (item.content as ContentBlock[]).map((b) =>
      b.type === "output_text" && typeof b.text === "string" ? { ...b, text } : b
    );
    return { ...item, content: newContent };
  }
  return item;
}

const STATUS_SLOT = "headroom-compress";

function formatFooterStatus(stats: Stats): string {
  if (!stats.enabled) return "compress: off";
  if (stats.requestCount === 0) return "compress: ready";
  const saved = stats.totalOriginalChars - stats.totalCompressedChars;
  const pct = stats.totalOriginalChars > 0 ? ((saved / stats.totalOriginalChars) * 100).toFixed(0) : "0";
  return `compress: -${pct}% (${(saved / 1000).toFixed(0)}k saved)`;
}

const factory: ExtensionFactory = (pi) => {
  const stats: Stats = {
    enabled: true,
    maxOutputChars: 32_000,
    maxAssistantChars: 12_000,
    requestCount: 0,
    compressedCount: 0,
    totalOriginalChars: 0,
    totalCompressedChars: 0,
    strategyCounts: {},
  };

  // Show initial status on session start
  pi.on("session_start" as any, async (_event: any, ctx: any) => {
    try { ctx.ui?.setStatus?.(STATUS_SLOT, formatFooterStatus(stats)); } catch {}
    return undefined;
  });

  pi.on("before_provider_request", async (event, _ctx) => {
    if (!stats.enabled) return undefined;
    const payload = event.payload as RequestPayload | undefined;
    if (!payload?.input || !Array.isArray(payload.input)) return undefined;

    const ctx = _ctx as any;

    stats.requestCount++;
    let items = payload.input as InputItem[];
    let modified = false;
    let totalOriginal = 0, totalCompressed = 0;

    // Phase 0: Read Lifecycle — replace stale/superseded reads with markers
    const lifecycle = applyReadLifecycle(items, DEFAULT_READ_LIFECYCLE_CONFIG, ccrStore);
    if (lifecycle.modified) {
      items = lifecycle.items as InputItem[];
      modified = true;
      stats.strategyCounts["read_lifecycle_stale"] = (stats.strategyCounts["read_lifecycle_stale"] || 0) + lifecycle.readsStale;
      stats.strategyCounts["read_lifecycle_superseded"] = (stats.strategyCounts["read_lifecycle_superseded"] || 0) + lifecycle.readsSuperseded;
    }

    // Phase 0.5: Output Shaper — reduce output tokens via verbosity steering + effort routing
    const shaped = shapeOutput(payload as Record<string, unknown>, DEFAULT_OUTPUT_SHAPER_CONFIG);
    if (shaped.changed) {
      modified = true;
      items = (shaped.payload.input ?? items) as InputItem[];
      for (const label of shaped.labels) {
        stats.strategyCounts[label] = (stats.strategyCounts[label] || 0) + 1;
      }
    }

    const compressed = items.map((item) => {
      const itemType = item.type ?? item.role ?? "";
      const text = getItemText(item);
      totalOriginal += text.length;

      // Only compress function_call_output and older assistant messages
      if (itemType === "function_call_output" && text.length > 500) {
        let cleaned = stripAnsi(text);
        cleaned = deduplicateConsecutiveLines(cleaned);
        const result = compressContent(cleaned);

        if (result.wasModified) {
          modified = true;
          stats.strategyCounts[result.strategy] = (stats.strategyCounts[result.strategy] || 0) + 1;
          const final = result.compressed.length > stats.maxOutputChars
            ? result.compressed.slice(0, stats.maxOutputChars / 2) + `\n⟨${result.compressed.length - stats.maxOutputChars} chars omitted⟩\n` + result.compressed.slice(-stats.maxOutputChars / 2)
            : result.compressed;
          totalCompressed += final.length;
          // Record to TOIN
          try {
            const parsed = JSON.parse(cleaned);
            if (Array.isArray(parsed)) {
              toin.recordCompression(computeSignature(parsed), parsed.length, 0, cleaned.length, final.length, result.strategy);
            }
          } catch {
            toin.recordCompression({ structureHash: "text", fieldCount: 0, hasNestedObjects: false, hasArrays: false, maxDepth: 0, hasErrorField: false, hasIdField: false, hasTimestampField: false }, 1, 1, cleaned.length, final.length, result.strategy);
          }
          return setItemText(item, final);
        }
        // Even if router didn't modify, apply size cap
        if (cleaned.length > stats.maxOutputChars) {
          modified = true;
          stats.strategyCounts["size_cap"] = (stats.strategyCounts["size_cap"] || 0) + 1;
          const half = Math.floor(stats.maxOutputChars / 2);
          const capped = cleaned.slice(0, half) + `\n⟨${cleaned.length - stats.maxOutputChars} chars omitted⟩\n` + cleaned.slice(-half);
          totalCompressed += capped.length;
          return setItemText(item, capped);
        }
        totalCompressed += cleaned.length;
        if (cleaned !== text) { modified = true; return setItemText(item, cleaned); }
        return item;
      }

      if (itemType === "message" && item.role === "assistant" && item.phase !== "final_answer") {
        if (text.length > stats.maxAssistantChars) {
          modified = true;
          stats.strategyCounts["assistant_trim"] = (stats.strategyCounts["assistant_trim"] || 0) + 1;
          const half = Math.floor(stats.maxAssistantChars / 2);
          const trimmed = text.slice(0, half) + `\n⟨${text.length - stats.maxAssistantChars} chars omitted⟩\n` + text.slice(-half);
          totalCompressed += trimmed.length;
          return setItemText(item, trimmed);
        }
      }

      totalCompressed += text.length;
      return item;
    });

    stats.totalOriginalChars += totalOriginal + lifecycle.charsSaved;
    stats.totalCompressedChars += totalCompressed;

    // Update footer status
    try { ctx.ui?.setStatus?.(STATUS_SLOT, formatFooterStatus(stats)); } catch {}

    if (modified) {
      stats.compressedCount++;
      return { ...payload, input: compressed };
    }
    return undefined;
  });

  // ─── Commands ────────────────────────────────────────────────────

  pi.registerCommand("headroom-compress-status", {
    description: "Show compression stats",
    handler: async (_args: string, ctx: any) => {
      const saved = stats.totalOriginalChars - stats.totalCompressedChars;
      const pct = stats.totalOriginalChars > 0 ? ((saved / stats.totalOriginalChars) * 100).toFixed(1) : "0";
      const strategies = Object.entries(stats.strategyCounts).map(([k, v]) => `  ${k}: ${v}`).join("\n");
      ctx.ui.notify(
        [
          `headroom-compress: ${stats.enabled ? "✅ enabled" : "❌ disabled"}`,
          `Requests: ${stats.requestCount} (${stats.compressedCount} compressed)`,
          `Total: ${stats.totalOriginalChars.toLocaleString()} → ${stats.totalCompressedChars.toLocaleString()} chars`,
          `Saved: ${saved.toLocaleString()} chars (${pct}%)`,
          `Max output: ${stats.maxOutputChars.toLocaleString()} | Max assistant: ${stats.maxAssistantChars.toLocaleString()}`,
          strategies ? `Strategies:\n${strategies}` : "",
        ].filter(Boolean).join("\n"),
        "info"
      );
    },
  });

  pi.registerCommand("headroom-compress-toggle", {
    description: "Toggle compression on/off",
    handler: async (_args: string, ctx: any) => {
      stats.enabled = !stats.enabled;
      ctx.ui.notify(`headroom-compress: ${stats.enabled ? "✅ enabled" : "❌ disabled"}`, "info");
      ctx.ui.setStatus?.(STATUS_SLOT, formatFooterStatus(stats));
    },
  });

  pi.registerCommand("headroom-compress-config", {
    description: "Configure compression: /headroom-compress-config [output|assistant|kompress] <number|on|off>",
    handler: async (args: string, ctx: any) => {
      const parts = args.trim().split(/\s+/);
      if (parts.length < 1 || !parts[0]) {
        ctx.ui.notify(`output=${stats.maxOutputChars}, assistant=${stats.maxAssistantChars}, kompress=${kompressConfig.enabled ? "on" : "off"}`, "info");
        return;
      }
      if (parts[0] === "kompress") {
        if (parts[1] === "on") { kompressConfig.enabled = true; ctx.ui.notify("Kompress ML enabled (adds ~5s per text block)", "info"); }
        else if (parts[1] === "off") { kompressConfig.enabled = false; ctx.ui.notify("Kompress ML disabled", "info"); }
        else { ctx.ui.notify(`kompress=${kompressConfig.enabled ? "on" : "off"} (use: on/off)`, "info"); }
        return;
      }
      if (parts.length < 2) {
        ctx.ui.notify(`output=${stats.maxOutputChars}, assistant=${stats.maxAssistantChars}, kompress=${kompressConfig.enabled ? "on" : "off"}`, "info");
        return;
      }
      const value = parseInt(parts[1], 10);
      if (isNaN(value) || value < 1000) { ctx.ui.notify("Value must be >= 1000", "error"); return; }
      if (parts[0] === "output") stats.maxOutputChars = value;
      else if (parts[0] === "assistant") stats.maxAssistantChars = value;
      else { ctx.ui.notify("Use: output, assistant, or kompress", "error"); return; }
      ctx.ui.notify(`${parts[0]} max = ${value.toLocaleString()}`, "info");
    },
  });

  // ─── CCR Retrieval Tool ─────────────────────────────────────────
  // Register a tool the LLM can call to retrieve compressed originals

  pi.registerCommand("headroom-retrieve", {
    description: "Retrieve original content by CCR hash. Usage: /headroom-retrieve <hash>",
    handler: async (args: string, ctx: any) => {
      const hash = args.trim();
      if (!hash || !/^[0-9a-f]{12}$/.test(hash)) {
        ctx.ui.notify("Usage: /headroom-retrieve <12-char-hex-hash>", "error");
        return;
      }
      const entry = ccrStore.retrieve(hash);
      if (!entry) {
        ctx.ui.notify(
          `CCR entry not found or expired (hash: ${hash}). ` +
          `Store has ${ccrStore.size} entries. TTL is 30 minutes.`,
          "warn"
        );
        return;
      }
      ctx.ui.notify(
        `Retrieved CCR entry ${hash} (${entry.original.length.toLocaleString()} chars, tool: ${entry.toolName || "unknown"}):\n` +
        entry.original.slice(0, 2000) +
        (entry.original.length > 2000 ? `\n... (${entry.original.length - 2000} more chars)` : ""),
        "info"
      );
    },
  });

  // ─── CacheAligner (detect volatile content on session start) ────

  pi.on("before_provider_request", async (event, _ctx) => {
    // Run CacheAligner check on first request only
    if (stats.requestCount !== 1) return undefined;
    const payload = event.payload as RequestPayload | undefined;
    if (!payload?.input) return undefined;
    const items = payload.input as InputItem[];
    const devItem = items.find((item) => item.role === "developer");
    if (!devItem) return undefined;
    const devContent = typeof devItem.content === "string" ? devItem.content : "";
    if (!devContent) return undefined;

    const alignment = analyzeCacheAlignment(devContent);
    if (!alignment.cacheStable) {
      // Log warning (non-blocking)
      try {
        const fs = await import("node:fs");
        fs.appendFileSync("/tmp/headroom-compress-cache-warnings.log",
          `[${new Date().toISOString()}] ${alignment.warnings.join("; ")}\n`);
      } catch {}
    }
    return undefined; // never modify
  });

  // ─── CCR Stats in status command (already above, add store info) ─
  pi.registerCommand("headroom-ccr-status", {
    description: "Show CCR store stats",
    handler: async (_args: string, ctx: any) => {
      const s = ccrStore.stats();
      ctx.ui.notify(
        [
          `CCR Store: ${s.size} entries`,
          `Total retrievals: ${s.totalRetrievals}`,
          `Oldest entry: ${s.oldestAgeMs > 0 ? Math.floor(s.oldestAgeMs / 1000) + "s ago" : "none"}`,
        ].join("\n"),
        "info"
      );
    },
  });

  pi.registerCommand("headroom-toin-status", {
    description: "Show TOIN learning stats",
    handler: async (_args: string, ctx: any) => {
      const s = toin.stats();
      const strategies = Object.entries(s.topStrategies).map(([k, v]) => `  ${k}: ${v}`).join("\n");
      ctx.ui.notify(
        [
          `TOIN: ${s.patternCount} tool patterns learned`,
          `Total compressions recorded: ${s.totalCompressions}`,
          strategies ? `Top strategies:\n${strategies}` : "",
        ].filter(Boolean).join("\n"),
        "info"
      );
    },
  });

  // Save TOIN on session shutdown
  pi.on("session_shutdown" as any, async () => {
    toin.save();
    return undefined;
  });
};

export default factory;
