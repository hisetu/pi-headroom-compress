/**
 * Kompress ML — Token importance scoring via headroom's ML model
 * 
 * Uses Python subprocess to call headroom's Kompress compressor.
 * The model (chopratejas/kompress-v2-base) runs locally via ONNX Runtime.
 * 
 * Architecture: ModernBERT-base + dual heads (token keep/discard + span importance)
 * 
 * Mirrors: headroom/transforms/kompress_compressor.py
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ─── Configuration ───────────────────────────────────────────────────

export interface KompressConfig {
  enabled: boolean;
  minCharsToCompress: number;
  targetRate: number; // 0.3 = keep 30% of tokens
  pythonPath: string;
}

const DEFAULT_PYTHON_PATHS = [
  join(homedir(), ".local/share/uv/tools/headroom-ai/bin/python"),
  join(homedir(), ".local/share/uv/tools/headroom-ai/bin/python3"),
  "python3",
];

function findPython(): string {
  for (const p of DEFAULT_PYTHON_PATHS) {
    try {
      if (p.startsWith("/") && !existsSync(p)) continue;
      execFileSync(p, ["-c", "import headroom"], { timeout: 5000, stdio: "pipe" });
      return p;
    } catch {}
  }
  return "";
}

export const DEFAULT_KOMPRESS_CONFIG: KompressConfig = {
  enabled: true,
  minCharsToCompress: 2000,
  targetRate: 0.3,
  pythonPath: findPython(),
};

// ─── Must-keep patterns (never drop these tokens) ────────────────────

const MUST_KEEP_RE = /\b0x[0-9A-Fa-f]+\b|(?<![\w.])\d+(?:\.\d+)?(?![\w.])|[A-Z_]{2,}|[a-z_][a-z0-9_]*\.[a-z0-9_.]+|\/[a-z0-9/._-]{2,}|\.[a-z]{2,4}\b|--?[a-z][\w-]*|\b[A-Z][a-z]+[A-Z]\w*/g;

// ─── Python compression script ───────────────────────────────────────

const COMPRESS_SCRIPT = `
import sys, json
from headroom.transforms.kompress_compressor import KompressCompressor

config_str = sys.stdin.read()
config = json.loads(config_str)
text = config["text"]
target_rate = config.get("target_rate", 0.3)

compressor = KompressCompressor()
result = compressor.compress(text, target_rate=target_rate)
output = {
    "compressed": result.compressed,
    "original_tokens": result.original_tokens,
    "compressed_tokens": result.compressed_tokens,
    "compression_ratio": result.compression_ratio,
}
sys.stdout.write(json.dumps(output))
`;

// ─── Public API ──────────────────────────────────────────────────────

export interface KompressResult {
  compressed: string;
  wasModified: boolean;
  originalTokens: number;
  compressedTokens: number;
  compressionRatio: number;
}

let available: boolean | null = null;

export function isKompressAvailable(config = DEFAULT_KOMPRESS_CONFIG): boolean {
  if (available !== null) return available;
  if (!config.pythonPath) { available = false; return false; }
  try {
    execFileSync(config.pythonPath, ["-c", "from headroom.transforms.kompress_compressor import is_kompress_available; assert is_kompress_available()"], { timeout: 10000, stdio: "pipe" });
    available = true;
  } catch {
    available = false;
  }
  return available;
}

export function kompressText(text: string, config = DEFAULT_KOMPRESS_CONFIG): KompressResult {
  const noOp: KompressResult = { compressed: text, wasModified: false, originalTokens: 0, compressedTokens: 0, compressionRatio: 1.0 };

  if (!config.enabled || !config.pythonPath) return noOp;
  if (text.length < config.minCharsToCompress) return noOp;
  if (!isKompressAvailable(config)) return noOp;

  try {
    const input = JSON.stringify({ text, target_rate: config.targetRate });
    const output = execFileSync(config.pythonPath, ["-c", COMPRESS_SCRIPT], {
      input,
      timeout: 30000, // 30s timeout for model inference
      stdio: ["pipe", "pipe", "pipe"],
      maxBuffer: 10 * 1024 * 1024, // 10MB
    });

    const result = JSON.parse(output.toString());
    if (!result.compressed || result.compressed === text) return noOp;

    return {
      compressed: result.compressed,
      wasModified: true,
      originalTokens: result.original_tokens || Math.ceil(text.length / 4),
      compressedTokens: result.compressed_tokens || Math.ceil(result.compressed.length / 4),
      compressionRatio: result.compression_ratio || result.compressed.length / text.length,
    };
  } catch {
    return noOp;
  }
}
