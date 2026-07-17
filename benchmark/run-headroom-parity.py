#!/usr/bin/env python3
import json
import sys

from headroom.transforms.content_detector import detect_content_type

with open(sys.argv[1], encoding="utf-8") as handle:
    fixture = json.load(handle)

content = fixture["content"]
detection = detect_content_type(content)
content_type = detection.content_type.value
compressed = content
strategy = "passthrough"
error = None

try:
    if content_type == "json_array":
        from headroom.transforms.smart_crusher import smart_crush_tool_output
        compressed, _, strategy = smart_crush_tool_output(content)
    elif content_type == "source_code":
        from headroom.transforms.code_compressor import CodeAwareCompressor
        result = CodeAwareCompressor().compress(content)
        compressed = result.compressed
        strategy = f"code:{result.language.value}"
    elif content_type == "build":
        from headroom.transforms.log_compressor import LogCompressor
        result = LogCompressor().compress(content)
        compressed = result.compressed
        strategy = "log"
    elif content_type == "diff":
        from headroom.transforms.diff_compressor import DiffCompressor
        result = DiffCompressor().compress(content)
        compressed = result.compressed
        strategy = "diff"
    elif content_type == "search":
        from headroom.transforms.search_compressor import SearchCompressor
        result = SearchCompressor().compress(content, context=fixture.get("query", ""))
        compressed = result.compressed
        strategy = "search"
    elif content_type == "html":
        strategy = "html-detected"
    elif content_type == "tabular":
        strategy = "tabular-detected"
except Exception as exc:
    error = str(exc)[:300]

print(json.dumps({
    "detection": {
        "type": content_type,
        "confidence": detection.confidence,
        "metadata": detection.metadata,
    },
    "strategy": str(strategy),
    "originalChars": len(content),
    "compressedChars": len(compressed),
    "compressedContent": compressed,
    "error": error,
}, default=str))
