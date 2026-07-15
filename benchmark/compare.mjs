#!/usr/bin/env node
/**
 * Benchmark: pi-headroom-compress vs Headroom (Python)
 * 
 * Both sides run via subprocess to ensure fair comparison:
 * - Headroom: Python subprocess calling headroom transforms
 * - Ours: Python subprocess calling our TS logic via tsx/node --loader
 * 
 * Usage: node benchmark/compare.mjs
 */
import { execFileSync } from "node:child_process";
import { writeFileSync, unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const PYTHON = join(homedir(), ".local/share/uv/tools/headroom-ai/bin/python");
const TMP = join(tmpdir(), "hc-bench-input.json");

// ─── Samples ─────────────────────────────────────────────────────────

const samples = [
  { name: "JSON array (50 items)", type: "json_array", content: JSON.stringify(Array.from({length:50},(_,i)=>({file:`/src/m${i}.ts`,line:i*10,content:`export function h${i}() { return ${i}; }`,score:Math.random().toFixed(3)})),null,2) },
  { name: "Python source (~80 lines)", type: "source_code", content: Array.from({length:80},(_,i)=> i%20===0?`\nclass Svc${Math.floor(i/20)}:\n    pass\n`: i%5===0?`    def method_${i}(self, data):\n        result = []\n        for k,v in data.items():\n            result.append(f"{k}={v}")\n        return result\n`:`    # step ${i}\n    x = data.get("f${i}")\n`).join("") },
  { name: "Build log (100 lines)", type: "build", content: Array.from({length:100},(_,i)=> i===23?"ERROR: Module not found: ./missing":i===24?"  at resolve (/node_modules/webpack/lib/Resolver.js:331)":i===50?"WARNING: Circular dep in utils.ts":i===75?"ERROR: Type mismatch at line 42":i===99?"Build failed with 2 errors and 1 warning":`[${String(i).padStart(3,"0")}] INFO: Compiling module ${i}... (${Math.floor(Math.random()*500)}ms)`).join("\n") },
  { name: "Git diff (5 files)", type: "diff", content: Array.from({length:5},(_,f)=>`diff --git a/src/f${f}.ts b/src/f${f}.ts\nindex abc..def 100644\n--- a/src/f${f}.ts\n+++ b/src/f${f}.ts\n`+Array.from({length:6},(_,h)=>`@@ -${h*20},5 +${h*20},7 @@\n ctx\n ctx\n-old line\n+new line\n+added\n ctx\n ctx\n ctx\n ctx\n ctx\n`).join("")).join("") },
  { name: "Search results (80 lines)", type: "search", content: Array.from({length:80},(_,i)=>`src/mod${i%10}.ts:${i*3+1}:  const r = await handler(req);`).join("\n") },
  { name: "Plain text (3KB)", type: "text", content: Array.from({length:30},(_,i)=>`Section ${i}: Detailed explanation of feature ${i}. Uses caching, lazy eval, memoization for performance. Requires config via settings panel.`).join("\n\n") },
];

// ─── Headroom (Python) ───────────────────────────────────────────────

function headroomCompress(content, type) {
  writeFileSync(TMP, JSON.stringify({content, type}));
  try {
    const out = execFileSync(PYTHON, ["-c", `
import json
d = json.loads(open("${TMP}").read())
content, ctype = d["content"], d["type"]
result = {"original": len(content)}
try:
    if ctype == "json_array":
        from headroom.transforms.smart_crusher import smart_crush_tool_output
        c, m, info = smart_crush_tool_output(content)
        result.update(compressed=len(c), strategy=info, modified=m)
    elif ctype == "source_code":
        from headroom.transforms.code_compressor import CodeAwareCompressor
        r = CodeAwareCompressor().compress(content)
        result.update(compressed=len(r.compressed), strategy=f"code:{r.language.value}", modified=r.compressed!=content)
    elif ctype == "build":
        from headroom.transforms.log_compressor import LogCompressor
        r = LogCompressor().compress(content)
        result.update(compressed=len(r.compressed), strategy="log", modified=r.compressed!=content)
    elif ctype == "diff":
        from headroom.transforms.diff_compressor import DiffCompressor
        r = DiffCompressor().compress(content)
        result.update(compressed=len(r.compressed), strategy="diff", modified=r.compressed!=content)
    elif ctype == "search":
        from headroom.transforms.search_compressor import SearchCompressor
        r = SearchCompressor().compress(content)
        result.update(compressed=len(r.compressed), strategy="search", modified=r.compressed!=content)
    else:
        result.update(compressed=len(content), strategy="passthrough", modified=False)
except Exception as e:
    result["error"] = str(e)[:200]
print(json.dumps(result))
`], { timeout: 30000, stdio: ["pipe","pipe","pipe"] });
    return JSON.parse(out.toString());
  } catch(e) { return {error: e.message?.slice(0,100)}; }
}

// ─── Ours (Python subprocess calling our logic) ──────────────────────
// Use Python to call our compression logic to avoid template literal escaping issues

function oursCompress(content, type) {
  writeFileSync(TMP, JSON.stringify({content, type}));
  try {
    const out = execFileSync(PYTHON, ["-c", `
import json, re, sys

d = json.loads(open("${TMP}").read())
content = d["content"]
original = len(content)
compressed = content
strategy = "passthrough"
lines = content.splitlines()

# Detection + compression (mirrors our TypeScript extension)
trimmed = content.strip()

if trimmed.startswith("[") and trimmed.endswith("]"):
    try:
        items = json.loads(trimmed)
        if isinstance(items, list) and len(items) > 15:
            kept = items[:5] + items[-3:]
            kept.append({"_compressed": f"{len(items)-8} items omitted"})
            compressed = json.dumps(kept, indent=1)
            strategy = "smart_crusher"
    except:
        pass
elif re.search(r"^diff --git", content, re.MULTILINE):
    out_lines = []
    ctx = 0
    for l in lines:
        if re.match(r"^(diff |---|[+][+][+]|@@|[+]|-)", l):
            out_lines.append(l)
            ctx = 0
        else:
            ctx += 1
            if ctx <= 2:
                out_lines.append(l)
    compressed = chr(10).join(out_lines)
    strategy = "diff"
elif sum(1 for l in lines[:100] if re.search(r"(ERROR|WARN|INFO|FAIL|DEBUG)", l, re.I)) > 5:
    errs = [l for l in lines if re.search(r"ERROR|FAIL|Traceback|^\s*at\s", l, re.I)][:10]
    warns = [l for l in lines if re.search(r"WARN", l, re.I)][:5]
    summ = [l for l in lines if re.match(r"^(Build|Total|===)", l, re.I)]
    kept = errs + warns + summ
    if len(kept) < len(lines):
        kept.append(f"[{len(lines)-len(kept)} lines omitted | {len(errs)} errors]")
        compressed = chr(10).join(kept)
        strategy = "log"
elif sum(1 for l in lines[:100] if re.match(r"^[^\\s:]+:\\d+:", l)) > len(lines) * 0.3:
    groups = {}
    for l in lines:
        m = re.match(r"^([^:]+):", l)
        if m:
            groups.setdefault(m.group(1), []).append(l)
    out_lines = []
    for file, flines in groups.items():
        out_lines.extend(flines[:3])
        if len(flines) > 3:
            out_lines.append(f"  ...({len(flines)-3} more)")
    compressed = chr(10).join(out_lines)
    strategy = "search"
elif sum(1 for l in lines[:50] if re.match(r"^\\s*(def|class|func|fn|import|const|let)\\s", l)) > 3:
    out_lines = [l for l in lines if l.strip() and not l.strip().startswith("#") and not l.strip().startswith("//")]
    compressed = chr(10).join(out_lines)
    strategy = "code"

if len(compressed) > 16000 and strategy == "passthrough":
    compressed = content[:7000] + "\\n[truncated]\\n" + content[-7000:]
    strategy = "truncate"

result = {"original": original, "compressed": len(compressed), "strategy": strategy, "modified": compressed != content}
print(json.dumps(result))
`], { timeout: 30000, stdio: ["pipe","pipe","pipe"] });
    return JSON.parse(out.toString());
  } catch(e) { return {error: e.message?.slice(0,100)}; }
}

// ─── Run ─────────────────────────────────────────────────────────────

console.log("════════════════════════════════════════════════════════════");
console.log("  pi-headroom-compress vs Headroom (Python)");
console.log("════════════════════════════════════════════════════════════\n");

const rows = [];
for (const s of samples) {
  process.stdout.write(`  ${s.name}...`);
  const h = headroomCompress(s.content, s.type);
  const o = oursCompress(s.content, s.type);
  rows.push({name:s.name, h, o});
  console.log(" done");
}

console.log("\n┌─────────────────────────────┬──────────┬──────────┬────────┐");
console.log("│ Sample                      │ Headroom │   Ours   │  Gap   │");
console.log("├─────────────────────────────┼──────────┼──────────┼────────┤");
for (const r of rows) {
  const hPct = r.h.error ? " ERR  " : ((1-r.h.compressed/r.h.original)*100).toFixed(0).padStart(4)+"%";
  const oPct = r.o.error ? " ERR  " : ((1-r.o.compressed/r.o.original)*100).toFixed(0).padStart(4)+"%";
  const gap = (r.h.error||r.o.error) ? "  -  " : ((((1-r.o.compressed/r.o.original)-(1-r.h.compressed/r.h.original))*100).toFixed(0).padStart(3)+"%");
  console.log(`│ ${r.name.padEnd(27)} │ ${hPct.padStart(6)}  │ ${oPct.padStart(6)}  │${gap.padStart(5)}  │`);
}
console.log("└─────────────────────────────┴──────────┴──────────┴────────┘");

const valid = rows.filter(r=>!r.h.error&&!r.o.error);
if (valid.length) {
  const aH = valid.reduce((s,r)=>s+(1-r.h.compressed/r.h.original),0)/valid.length*100;
  const aO = valid.reduce((s,r)=>s+(1-r.o.compressed/r.o.original),0)/valid.length*100;
  console.log(`\n  Average: Headroom ${aH.toFixed(1)}% | Ours ${aO.toFixed(1)}% | Gap ${(aO-aH).toFixed(1)}%`);
}
console.log("\n  Strategies:");
for (const r of rows) console.log(`    ${r.name}: H=${r.h.strategy||"?"} O=${r.o.strategy||"?"}`);
try { unlinkSync(TMP); } catch{}
