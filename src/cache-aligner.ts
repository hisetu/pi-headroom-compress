/**
 * CacheAligner — Detector-only transform
 * 
 * Detects volatile/dynamic content in system prompts that prevents
 * provider KV cache hits. Reports warnings but does NOT modify content.
 * 
 * Mirrors: headroom/transforms/cache_aligner.py
 */

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const ISO8601_RE = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})/g;
const HEX_HASH_RE = /\b[0-9a-f]{32}\b|\b[0-9a-f]{40}\b|\b[0-9a-f]{64}\b/gi;
const JWT_RE = /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g;

export interface VolatileFinding {
  label: "uuid" | "iso8601" | "hex_hash" | "jwt";
  sample: string;
  count: number;
}

export interface CacheAlignmentResult {
  findings: VolatileFinding[];
  cacheStable: boolean;
  warnings: string[];
}

/**
 * Analyze a system/developer prompt for volatile content.
 * Does NOT modify the prompt — only reports.
 */
export function analyzeCacheAlignment(systemPrompt: string): CacheAlignmentResult {
  const findings: VolatileFinding[] = [];

  const uuids = systemPrompt.match(UUID_RE);
  if (uuids && uuids.length > 0) {
    findings.push({ label: "uuid", sample: uuids[0].slice(0, 20), count: uuids.length });
  }

  const timestamps = systemPrompt.match(ISO8601_RE);
  if (timestamps && timestamps.length > 0) {
    findings.push({ label: "iso8601", sample: timestamps[0].slice(0, 25), count: timestamps.length });
  }

  const hashes = systemPrompt.match(HEX_HASH_RE);
  if (hashes && hashes.length > 0) {
    findings.push({ label: "hex_hash", sample: hashes[0].slice(0, 16) + "...", count: hashes.length });
  }

  const jwts = systemPrompt.match(JWT_RE);
  if (jwts && jwts.length > 0) {
    findings.push({ label: "jwt", sample: jwts[0].slice(0, 20) + "...", count: jwts.length });
  }

  const cacheStable = findings.length === 0;
  const warnings = findings.map(
    (f) => `Cache prefix unstable: found ${f.count} ${f.label}(s) in system prompt (e.g. "${f.sample}")`
  );

  return { findings, cacheStable, warnings };
}
