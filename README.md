# pi-headroom-compress

Pure TypeScript context compression extension for [Pi](https://github.com/earendil-works/pi-coding-agent). Implements Headroom-equivalent compression algorithms as a Pi extension — no proxy, no external service, no auth issues.

## Why

Running a remote Headroom proxy for GitHub Copilot's `gpt-5.4` is blocked by integrator/WebSocket limitations ([headroom#1910](https://github.com/headroomlabs-ai/headroom/issues/1910)). This extension takes a different approach:

- Hooks into Pi's `before_provider_request` event
- Compresses tool outputs and conversation history **before** Pi sends to the LLM
- Pi handles all provider auth/routing/WebSocket itself
- Works with **all providers** including `github-copilot gpt-5.4`

## Compression Rate

~20% on real coding sessions (tested with Python/TypeScript tool outputs).

## Features

| Strategy | Description | Inspired by |
|----------|-------------|-------------|
| **SmartCrusher** | JSON array compression with BM25 scoring, dedup, lossless tabular compaction | `headroom/transforms/smart_crusher.py` |
| **CodeCompressor** | tree-sitter AST parsing, symbol importance analysis, body budget allocation | `headroom/transforms/code_compressor.py` |
| **LogCompressor** | Error/warning prioritization, stack trace handling, context lines | `headroom/transforms/log_compressor.py` |
| **DiffCompressor** | Keep changes, compress context lines, limit hunks per file | `headroom/transforms/diff_compressor.py` |
| **SearchCompressor** | Group by file, limit per-file matches | `headroom/transforms/search_compressor.py` |
| **ContentDetector** | Auto-detect content type and route to appropriate compressor | `headroom/transforms/content_detector.py` |
| **CCR Store** | Reversible compression — originals cached for retrieval on demand | `headroom/cache/compression_store.py` |
| **CacheAligner** | Detect volatile content in system prompt (UUID, timestamp, JWT, hash) | `headroom/transforms/cache_aligner.py` |

## Installation

Add to your Pi `settings.json` packages:

```json
{
  "packages": [
    "git:github.com/hisetu/pi-headroom-compress"
  ]
}
```

Then install tree-sitter dependencies (for AST-based code compression):

```bash
cd ~/.pi/agent/git/github.com/hisetu/pi-headroom-compress
npm install
```

## Commands

| Command | Description |
|---------|-------------|
| `/headroom-compress-status` | Show compression stats and strategies used |
| `/headroom-compress-toggle` | Enable/disable compression |
| `/headroom-compress-config output 20000` | Set max tool output chars before truncation |
| `/headroom-compress-config assistant 8000` | Set max assistant message chars |
| `/headroom-ccr-status` | Show CCR store stats |
| `/headroom-retrieve <hash>` | Retrieve original content by CCR hash |

## Architecture

### High-Level Flow

```
payload.input[]  (from before_provider_request hook)
  │
  ├─ developer item       → ANSI strip + line dedup (usually untouched)
  ├─ function_call_output → detectContentType() → compressContent()
  ├─ assistant items      → trim to last N chars
  └─ user items           → pass through
          │
          ▼
  LLM Provider (Pi handles auth/routing/WebSocket directly)
```

### Content Detection → Strategy Selection

Each tool output block is first classified by `detectContentType()`, which samples the first 200 lines and applies detectors in priority order. The first detector that exceeds its confidence threshold wins:

| Priority | Detection Rule | Type | Compressor | What it does |
|----------|---------------|------|------------|-------------|
| 1 | Starts with `[`, valid JSON array | `json_array` | **SmartCrusher** | BM25-scored top-N + tail items, dedup, lossless tabular compaction |
| 2 | `diff --git` headers + `+/-` lines ≥ 0.7 confidence | `diff` | **DiffCompressor** | Keep hunk headers + changed lines + 2 context lines; cap hunks per file |
| 3 | `file:line:` pattern in > 30% of lines | `search` | **SearchCompressor** | Group by file, keep first 3 hits per file, summarize remainder |
| 4 | `ERROR/WARN/INFO/DEBUG` keywords in > 50% of lines | `build` | **LogCompressor** | Prioritize errors + stack traces + summary; skip repetitive INFO lines |
| 5 | `def/class/func/import/const` keywords in > 50% of sample | `source_code` | **CodeCompressor** | AST via tree-sitter (body budget allocation); regex fallback if AST fails |
| 6 | None of the above | `text` | **Kompress ML** → mid-truncate → passthrough | ML compression if available and text is large enough; else truncate center |

### Additional Processing Layers

These layers run before or around the content router:

| Layer | When | Purpose |
|-------|------|--------|
| **ANSI strip** | Pre-detection | Remove terminal escape codes |
| **Line dedup** | Pre-detection | Collapse N identical consecutive lines → `... (N lines omitted)` |
| **Read Lifecycle** | Pre-detection | Same file read twice within TTL → replace with CCR hash reference |
| **Output Shaper** | Post-compression | Inject system prompt pressure for concise model output |
| **TOIN** | Post-compression | Observe which strategy was used and how much was saved (learning only) |
| **CCR Store** | Post-compression | Cache original content by hash for on-demand retrieval (`/headroom-retrieve`) |

### Decision Summary

> **One sentence**: look at the content shape (JSON / diff / log / code / search / text), dispatch to the specialized compressor, keep only structurally important information for LLM decision-making, discard repetition and noise.

## Supported Languages (CodeCompressor)

tree-sitter grammars included:

- Python
- JavaScript
- TypeScript / TSX
- Go
- Rust
- Java
- C

## Configuration

Default settings (adjustable via `/headroom-compress-config`):

| Setting | Default | Description |
|---------|---------|-------------|
| Max tool output | 32,000 chars | Truncate after compression if still over |
| Max assistant msg | 12,000 chars | Trim older assistant messages |
| SmartCrusher max items | 15 | Keep top-N items from JSON arrays |
| Code target rate | 0.2 | Keep ~20% of function bodies |
| CCR TTL | 30 minutes | How long originals are cached |

## Benchmark

Run the end-to-end comparison against the installed Python Headroom package:

```bash
npm run benchmark
```

The benchmark imports the extension's real TypeScript `compressContent()` function—there is no benchmark-only reimplementation. It reports:

- character-weighted compression savings;
- the strategy selected by each implementation;
- retention of predefined critical markers such as errors, stack frames, symbols, filenames, and diff changes.

These synthetic checks measure compression and basic information retention, not model-answer correctness. Use real task A/B evaluation before making a general quality claim.

## License

MIT
