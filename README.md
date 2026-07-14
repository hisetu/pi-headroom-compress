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

```
Pi (any provider, any model)
  │
  ├── before_provider_request hook
  │     ├── ContentDetector → route to compressor
  │     ├── SmartCrusher (JSON arrays)
  │     ├── CodeCompressor (AST-based, tree-sitter)
  │     ├── LogCompressor (error prioritization)
  │     ├── DiffCompressor (keep changes)
  │     ├── SearchCompressor (group by file)
  │     └── CCR Store (save originals for retrieval)
  │
  ▼
  LLM Provider (Pi handles auth/routing/WebSocket directly)
```

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

## Comparison with Headroom Proxy

| | Headroom Proxy | This Extension |
|---|---|---|
| Auth handling | ❌ Complex (integrator issues) | ✅ None (Pi handles it) |
| Network | ❌ Needs proxy reachable | ✅ Local, zero network |
| WebSocket | ❌ Relay issues | ✅ Not involved |
| gpt-5.4 via Copilot | ❌ Blocked | ✅ Works |
| Compression quality | ✅ Rust + ML models | ✅ Same algorithms (minus Kompress ML) |
| Multi-machine sharing | ✅ Centralized | ❌ Per-machine |
| Setup | Medium (k8s/Docker) | Simple (`npm install`) |

## License

MIT
