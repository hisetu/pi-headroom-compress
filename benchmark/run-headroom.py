#!/usr/bin/env python3
import json
import sys

input_path = sys.argv[1]
with open(input_path, encoding="utf-8") as handle:
    data = json.load(handle)

content = data["content"]
content_type = data["type"]
compressed = content
strategy = "passthrough"

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
        result = SearchCompressor().compress(content)
        compressed = result.compressed
        strategy = "search"
except Exception as error:
    print(json.dumps({"error": str(error)[:300]}))
    sys.exit(0)

print(json.dumps({
    "original": len(content),
    "compressed": len(compressed),
    "compressedContent": compressed,
    "strategy": str(strategy),
    "modified": compressed != content,
}))
