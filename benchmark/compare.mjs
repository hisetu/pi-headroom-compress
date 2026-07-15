#!/usr/bin/env node
/**
 * Benchmark: pi-headroom-compress vs Headroom (Python)
 * Usage: node benchmark/compare.mjs
 */
import { execFileSync } from "node:child_process";
import { writeFileSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";

const PYTHON = join(homedir(), ".local/share/uv/tools/headroom-ai/bin/python");
const TMP_INPUT = join(tmpdir(), "hc-bench-input.txt");
const TMP_SCRIPT = join(tmpdir(), "hc-bench-ours.js");

const samples = [
  { name: "JSON array (50 items)", type: "json_array", content: JSON.stringify(Array.from({length:50},(_,i)=>({file:`/src/m${i}.ts`,line:i*10,content:`export function h${i}() { return ${i}; }`,score:Math.random().toFixed(3)})),null,2) },
  { name: "Python source (~80 lines)", type: "source_code", content: Array.from({length:80},(_,i)=> i%20===0?`\nclass Svc${Math.floor(i/20)}:\n    pass\n`: i%5===0?`    def method_${i}(self, data):\n        result = []\n        for k,v in data.items():\n            result.append(f"{k}={v}")\n        return result\n`:`    # step ${i}\n    x = data.get("f${i}")\n`).join("") },
  { name: "Build log (100 lines)", type: "build", content: Array.from({length:100},(_,i)=> i===23?"ERROR: Module not found: ./missing":i===50?"WARNING: Circular dep in utils.ts":i===75?"ERROR: Type mismatch at line 42":`[${String(i).padStart(3,"0")}] INFO: Compiling module ${i}... (${Math.floor(Math.random()*500)}ms)`).join("\n") },
  { name: "Git diff (5 files)", type: "diff", content: Array.from({length:5},(_,f)=>`diff --git a/src/f${f}.ts b/src/f${f}.ts\nindex abc..def 100644\n--- a/src/f${f}.ts\n+++ b/src/f${f}.ts\n`+Array.from({length:6},(_,h)=>`@@ -${h*20},5 +${h*20},7 @@\n ctx\n ctx\n-old line\n+new line\n+added\n ctx\n ctx\n ctx\n ctx\n ctx\n`).join("")).join("") },
  { name: "Search results (80 lines)", type: "search", content: Array.from({length:80},(_,i)=>`src/mod${i%10}.ts:${i*3+1}:  const r = await handler(req);`).join("\n") },
  { name: "Plain text (3KB)", type: "text", content: Array.from({length:30},(_,i)=>`Section ${i}: Detailed explanation of feature ${i}. Uses caching, lazy eval, memoization for performance. Requires config via settings panel.`).join("\n\n") },
];

// Our compression script (written to temp file to avoid escaping hell)
const OUR_SCRIPT = `
const fs = require("fs");
const content = fs.readFileSync(process.argv[2], "utf-8");
const orig = content.length;
let comp = content, strat = "passthrough";
const t = content.trim();
const lines = content.split("\\n");

if (t.startsWith("[")) {
  try {
    const a = JSON.parse(t);
    if (Array.isArray(a) && a.length > 15) {
      const k = [...a.slice(0, 5), ...a.slice(-3)];
      k.push({ _c: (a.length - 8) + " omit" });
      comp = JSON.stringify(k, null, 1);
      strat = "smart_crusher";
    }
  } catch {}
} else if (/^diff --git/m.test(content)) {
  const o = [];
  let ctx = 0;
  for (const l of lines) {
    if (/^(diff |---|\\+\\+\\+|@@|\\+|-)/.test(l)) { o.push(l); ctx = 0; }
    else { ctx++; if (ctx <= 2) o.push(l); }
  }
  comp = o.join("\\n");
  strat = "diff";
} else if (lines.slice(0, 100).filter(l => /(ERROR|WARN|INFO|FAIL|DEBUG)/i.test(l)).length > 5) {
  const errs = lines.filter(l => /ERROR|FAIL|Traceback|^\s*at\\s/i.test(l));
  const warns = lines.filter(l => /WARN/i.test(l)).slice(0, 5);
  const summ = lines.filter(l => /^Build|^Total|^===/i.test(l));
  const kept = [...errs.slice(0, 10), ...warns, ...summ];
  if (kept.length < lines.length) {
    kept.push("[" + (lines.length - kept.length) + " lines omitted]");
    comp = kept.join("\\n");
    strat = "log";
  }
} else if (lines.filter(l => /^[^\\s:]+:\\d+:/.test(l)).length > lines.length * 0.3) {
  const g = new Map();
  for (const l of lines) {
    const m = l.match(/^([^:]+):/);
    if (m) { if (!g.has(m[1])) g.set(m[1], []); g.get(m[1]).push(l); }
  }
  const o = [];
  for (const [, v] of g) { o.push(...v.slice(0, 3)); if (v.length > 3) o.push("  ...(" + (v.length - 3) + " more)"); }
  comp = o.join("\\n");
  strat = "search";
} else if (lines.slice(0, 50).filter(l => /^\s*(def|class|func|fn|import|const|let)\\s/.test(l)).length > 3) {
  comp = lines.filter(l => { const x = l.trim(); return x && !x.startsWith("#") && !x.startsWith("//"); }).join("\\n");
  strat = "code";
}

if (comp.length > 16000 && strat === "passthrough") {
  comp = content.slice(0, 7000) + "\\n[truncated]\\n" + content.slice(-7000);
  strat = "truncate";
}
console.log(JSON.stringify({ original: orig, compressed: comp.length, strategy: strat, modified: comp !== content }));
`;

writeFileSync(TMP_SCRIPT, OUR_SCRIPT);

function headroomCompress(content, type) {
  writeFileSync(TMP_INPUT, JSON.stringify({content, type}));
  try {
    const out = execFileSync(PYTHON, ["-c", `
import json
d = json.loads(open("${TMP_INPUT}").read())
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

function oursCompress(content) {
  writeFileSync(TMP_INPUT, content);
  try {
    const out = execFileSync("node", [TMP_SCRIPT, TMP_INPUT], { timeout: 10000, stdio: ["pipe","pipe","pipe"] });
    return JSON.parse(out.toString());
  } catch(e) { return {error: e.message?.slice(0,100)}; }
}

// Run
console.log("════════════════════════════════════════════════════════════");
console.log("  pi-headroom-compress vs Headroom (Python)");
console.log("════════════════════════════════════════════════════════════\n");

const rows = [];
for (const s of samples) {
  process.stdout.write(`  ${s.name}...`);
  const h = headroomCompress(s.content, s.type);
  const o = oursCompress(s.content);
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

try { unlinkSync(TMP_INPUT); unlinkSync(TMP_SCRIPT); } catch{}
