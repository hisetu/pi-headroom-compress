#!/usr/bin/env node
/**
 * Benchmark: compare our compression vs Headroom (Python)
 * Usage: node benchmark/compare.mjs
 */
import { execFileSync } from "node:child_process";
import { writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";

const PYTHON = join(homedir(), ".local/share/uv/tools/headroom-ai/bin/python");
const TMP = join(tmpdir(), "hc-bench-input.json");

const samples = [
  { name: "JSON array (50 items)", type: "json_array", content: JSON.stringify(Array.from({length:50},(_,i)=>({file:`/src/m${i}.ts`,line:i*10,content:`export function h${i}() { return ${i}; }`,score:Math.random().toFixed(3)})),null,2) },
  { name: "Python source (~80 lines)", type: "source_code", content: Array.from({length:80},(_,i)=> i%20===0?`\nclass Svc${Math.floor(i/20)}:\n    pass\n`: i%5===0?`    def method_${i}(self, data):\n        result = []\n        for k,v in data.items():\n            result.append(f"{k}={v}")\n        return result\n`:`    # step ${i}\n    x = data.get("f${i}")\n`).join("") },
  { name: "Build log (100 lines)", type: "build", content: Array.from({length:100},(_,i)=> i===23?"ERROR: Module not found: ./missing":i===50?"WARNING: Circular dep in utils.ts":i===75?"ERROR: Type mismatch at line 42":`[${String(i).padStart(3,"0")}] INFO: Compiling module ${i}... (${Math.floor(Math.random()*500)}ms)`).join("\n") },
  { name: "Git diff (5 files)", type: "diff", content: Array.from({length:5},(_,f)=>`diff --git a/src/f${f}.ts b/src/f${f}.ts\nindex abc..def 100644\n--- a/src/f${f}.ts\n+++ b/src/f${f}.ts\n`+Array.from({length:6},(_,h)=>`@@ -${h*20},5 +${h*20},7 @@\n ctx\n ctx\n-old line\n+new line\n+added\n ctx\n ctx\n ctx\n ctx\n ctx\n`).join("")).join("") },
  { name: "Search results (80 lines)", type: "search", content: Array.from({length:80},(_,i)=>`src/mod${i%10}.ts:${i*3+1}:  const r = await handler(req);`).join("\n") },
  { name: "Plain text (3KB)", type: "text", content: Array.from({length:30},(_,i)=>`Section ${i}: Detailed explanation of feature ${i}. Uses caching, lazy eval, memoization for performance. Requires config via settings panel.`).join("\n\n") },
];

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

function oursCompress(content, type) {
  writeFileSync(TMP, content);
  try {
    const out = execFileSync("node", ["-e", `
const fs=require("fs");
const content=fs.readFileSync("${TMP}","utf-8");
const orig=content.length;
let comp=content,strat="passthrough";
const t=content.trim();
if(t.startsWith("[")){try{const a=JSON.parse(t);if(Array.isArray(a)&&a.length>15){const k=[...a.slice(0,5),...a.slice(-3)];k.push({_c:(a.length-8)+" omit"});comp=JSON.stringify(k,null,1);strat="smart_crusher";}}catch{}}
else if(/^diff --git/m.test(content)){const ls=content.split("\\n"),o=[];let c=0;for(const l of ls){if(/^(diff |---|\\+\\+\\+|@@|\\+|-)/.test(l)){o.push(l);c=0;}else{c++;if(c<=2)o.push(l);}}comp=o.join("\\n");strat="diff";}
else if(content.split("\\n").slice(0,50).filter(l=>/\\b(ERROR|WARN|FAIL)\\b/i.test(l)).length>2){const ls=content.split("\\n"),k=ls.filter(l=>/ERROR|WARN|FAIL|Trace|===/i.test(l)).slice(0,50);if(k.length<ls.length){k.push("["+(ls.length-k.length)+" omitted]");comp=k.join("\\n");strat="log";}}
else if(content.split("\\n").slice(0,50).filter(l=>/^\\s*(def|class|func|fn|import|const|let)\\s/.test(l)).length>3){comp=content.split("\\n").filter(l=>{const x=l.trim();return x&&!x.startsWith("#")&&!x.startsWith("//");}).join("\\n");strat="code";}
else if(content.split("\\n").filter(l=>/^[^\\s:]+:\\d+:/.test(l)).length>content.split("\\n").length*0.3){const ls=content.split("\\n"),g=new Map();for(const l of ls){const m=l.match(/^([^:]+):/);if(m){if(!g.has(m[1]))g.set(m[1],[]);g.get(m[1]).push(l);}}const o=[];for(const[,v]of g){o.push(...v.slice(0,5));if(v.length>5)o.push("  ...("+( v.length-5)+" more)");}comp=o.join("\\n");strat="search";}
if(comp.length>16000&&strat==="passthrough"){comp=content.slice(0,7000)+"\\n[trunc]\\n"+content.slice(-7000);strat="truncate";}
console.log(JSON.stringify({original:orig,compressed:comp.length,strategy:strat,modified:comp!==content}));
`], { timeout: 10000, stdio: ["pipe","pipe","pipe"] });
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
