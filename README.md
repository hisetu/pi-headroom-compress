# pi-headroom-compress

A Pi-native context compression extension for [Pi](https://github.com/earendil-works/pi-coding-agent). It is an independent, streamlined TypeScript implementation inspired by Headroom's architecture—not a byte-compatible or 1:1 port. It runs without a proxy or external service; optional Kompress ML delegates to a locally installed Headroom Python package.

## Why

Running a remote Headroom proxy for GitHub Copilot's `gpt-5.4` is blocked by integrator/WebSocket limitations ([headroom#1910](https://github.com/headroomlabs-ai/headroom/issues/1910)). This extension takes a different approach:

- Hooks into Pi's `before_provider_request` event
- Compresses tool outputs and conversation history **before** Pi sends to the LLM
- Pi handles all provider auth/routing/WebSocket itself
- Works with **all providers** including `github-copilot gpt-5.4`

## Compression Rate

Observed savings are ~20% on real coding sessions with Python/TypeScript tool outputs. Results vary by workload and more aggressive compression does not by itself prove equivalent answer quality.

## Compatibility Scope

This project ports selected ideas and behavior, not complete Headroom feature parity. Detectors, thresholds, supported formats, metadata, feedback systems, and exact compressed output may differ. The benchmark validates compression and selected marker retention; it does not establish byte parity or model-answer equivalence.

## Features

| Strategy | Description | Inspired by |
|----------|-------------|-------------|
| **SmartCrusher** | JSON array compression with BM25 scoring, dedup, lossless tabular compaction | `headroom/transforms/smart_crusher.py` |
| **CodeCompressor** | tree-sitter AST parsing, symbol importance analysis, body budget allocation | `headroom/transforms/code_compressor.py` |
| **LogCompressor** | Error/warning prioritization, stack trace handling, context lines | `headroom/transforms/log_compressor.py` |
| **DiffCompressor** | Keep changes, compress context lines, limit hunks per file | `headroom/transforms/diff_compressor.py` |
| **SearchCompressor** | Group by file, limit per-file matches | `headroom/transforms/search_compressor.py` |
| **ContentDetector** | Auto-detect content type and route to appropriate compressor | `headroom/transforms/content_detector.py` |
| **CCR Store** | Reversible compression — originals persisted in SQLite for retrieval across reloads | `headroom/cache/compression_store.py` |
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
| `/headroom-compress-config kompress on` | Enable Kompress ML (adds ~5s per text block) |
| `/headroom-compress-config kompress off` | Disable Kompress ML (default) |
| `/headroom-ccr-status` | Show CCR store stats |
| `/headroom-retrieve <hash>` | Retrieve original content by CCR hash |

## Footer Status

After the first provider request, the Pi footer shows compression and estimated cost savings:

```text
compress: -35% ($10.0/$1000.0 saved)
                └─┬─┘ └──┬──┘
                  │      └─ all-time savings across sessions
                  └─ savings in the current Pi session
```

The percentage is the current session's character reduction. Dollar savings follow Headroom's model-aware accounting approach:

1. estimate the request's tokens before and after compression using Pi's `ceil(chars / 4)` context estimator;
2. read the active model's input price from Pi's model registry;
3. apply the highest matching long-context pricing tier, when configured;
4. fall back to `$3 / 1M` input tokens only when model pricing is unavailable;
5. store the model, provider, tokens, selected rate, pricing source, and USD value at event time so historical totals do not change when pricing changes later.

The extension cannot apply provider cache-read/cache-write discounts because `before_provider_request` does not expose the eventual cache usage breakdown. Values are therefore model-aware list-price estimates, not provider billing data.

Each compression is appended to the `savings_events` ledger in `~/.headroom/pi-ccr-store.db`. The all-time footer value is the sum of that ledger across sessions and processes.

Before any provider request, the footer displays `compress: ready`; while disabled, it displays `compress: off`.

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
| **CCR Store** | Post-compression | Persist originals by hash in SQLite for on-demand retrieval (`/headroom-retrieve`) |

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
| CCR TTL | 30 minutes | How long originals remain in `~/.headroom/pi-ccr-store.db` |
| Kompress ML | off | ML text compression (~69% savings, ~5s latency) |

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

### Golden parity report

Run stable fixtures through both the installed Python Headroom implementation and this extension's real TypeScript implementation:

```bash
npm run parity
```

The report compares content detection, normalized strategy families, compression savings, byte-identical output, and critical-marker retention. Known differences are reported rather than hidden; runner failures return a non-zero exit status. Optionally save the complete machine-readable report:

```bash
node benchmark/parity.mjs --json parity-report.json
```

The fixture corpus currently covers JSON arrays, git diffs, HTML, CSV, ripgrep output, build logs, Python, C++, and plain documentation. A parity report is diagnostic evidence—not a claim that all outputs should become byte-identical, because some differences are intentional Pi adaptations.

## Attribution

This project is a derivative work of [Headroom](https://github.com/headroomlabs-ai/headroom) (Copyright 2025 Headroom Contributors, Apache License 2.0). The compression algorithms are independent TypeScript reimplementations inspired by Headroom's Python originals. See [NOTICE](./NOTICE) for details.

## License

MIT — see [LICENSE](./LICENSE).

The original Headroom project is licensed under Apache 2.0 — see [LICENSE-APACHE-2.0](./LICENSE-APACHE-2.0).
