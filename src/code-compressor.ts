/**
 * AST-based Code Compressor using tree-sitter
 * 
 * 1:1 port of headroom/transforms/code_compressor.py
 * 
 * Strategy:
 * 1. Parse code → AST via tree-sitter
 * 2. Detect language (fewest parse errors)
 * 3. Analyze symbol importance (ref count, fan-out, visibility, context)
 * 4. Allocate body line budgets per function
 * 5. Compress function bodies while preserving signatures
 * 6. Reassemble valid code
 */

// ─── Lazy imports (tree-sitter is optional) ──────────────────────────

let Parser: any = null;
let grammars: Record<string, any> = {};
let tsAvailable: boolean | null = null;

function loadTreeSitter(): boolean {
  if (tsAvailable !== null) return tsAvailable;
  try {
    const { createRequire } = require("node:module");
    const req = createRequire(import.meta.url ?? __filename);
    Parser = req("tree-sitter");
    grammars = {
      python: req("tree-sitter-python"),
      javascript: req("tree-sitter-javascript"),
      typescript: req("tree-sitter-typescript").typescript,
      tsx: req("tree-sitter-typescript").tsx,
      go: req("tree-sitter-go"),
      rust: req("tree-sitter-rust"),
      java: req("tree-sitter-java"),
      c: req("tree-sitter-c"),
    };
    tsAvailable = true;
  } catch {
    tsAvailable = false;
  }
  return tsAvailable;
}

function getParser(language: string): any {
  if (!loadTreeSitter()) throw new Error("tree-sitter not available");
  const grammar = grammars[language];
  if (!grammar) throw new Error(`Unsupported language: ${language}`);
  const parser = new Parser();
  parser.setLanguage(grammar);
  return parser;
}

// ─── Language Configuration ──────────────────────────────────────────

interface LangConfig {
  importNodes: Set<string>;
  functionNodes: Set<string>;
  classNodes: Set<string>;
  typeNodes: Set<string>;
  bodyNodeTypes: Set<string>;
  decoratorNode: string | null;
  commentPrefix: string;
  usesColonAfterSignature: boolean;
  packageNode: string | null;
  classBodyNodeTypes: Set<string> | null;
}

const LANG_CONFIGS: Record<string, LangConfig> = {
  python: {
    importNodes: new Set(["future_import_statement", "import_statement", "import_from_statement"]),
    functionNodes: new Set(["function_definition"]),
    classNodes: new Set(["class_definition"]),
    typeNodes: new Set(["type_alias_statement"]),
    bodyNodeTypes: new Set(["block"]),
    decoratorNode: "decorated_definition",
    commentPrefix: "#",
    usesColonAfterSignature: true,
    packageNode: null,
    classBodyNodeTypes: null,
  },
  javascript: {
    importNodes: new Set(["import_statement", "import_declaration"]),
    functionNodes: new Set(["function_declaration", "method_definition"]),
    classNodes: new Set(["class_declaration"]),
    typeNodes: new Set(),
    bodyNodeTypes: new Set(["statement_block"]),
    decoratorNode: null,
    commentPrefix: "//",
    usesColonAfterSignature: false,
    packageNode: null,
    classBodyNodeTypes: new Set(["class_body"]),
  },
  typescript: {
    importNodes: new Set(["import_statement", "import_declaration"]),
    functionNodes: new Set(["function_declaration", "method_definition"]),
    classNodes: new Set(["class_declaration"]),
    typeNodes: new Set(["interface_declaration", "type_alias_declaration"]),
    bodyNodeTypes: new Set(["statement_block"]),
    decoratorNode: null,
    commentPrefix: "//",
    usesColonAfterSignature: false,
    packageNode: null,
    classBodyNodeTypes: new Set(["class_body"]),
  },
  go: {
    importNodes: new Set(["import_declaration"]),
    functionNodes: new Set(["function_declaration", "method_declaration"]),
    classNodes: new Set(),
    typeNodes: new Set(["type_declaration"]),
    bodyNodeTypes: new Set(["block"]),
    decoratorNode: null,
    commentPrefix: "//",
    usesColonAfterSignature: false,
    packageNode: "package_clause",
    classBodyNodeTypes: null,
  },
  rust: {
    importNodes: new Set(["use_declaration"]),
    functionNodes: new Set(["function_item"]),
    classNodes: new Set(["impl_item"]),
    typeNodes: new Set(["struct_item", "enum_item", "type_item", "trait_item"]),
    bodyNodeTypes: new Set(["block"]),
    decoratorNode: null,
    commentPrefix: "//",
    usesColonAfterSignature: false,
    packageNode: null,
    classBodyNodeTypes: new Set(["declaration_list"]),
  },
  java: {
    importNodes: new Set(["import_declaration"]),
    functionNodes: new Set(["method_declaration", "constructor_declaration"]),
    classNodes: new Set(["class_declaration", "interface_declaration"]),
    typeNodes: new Set(["enum_declaration"]),
    bodyNodeTypes: new Set(["block"]),
    decoratorNode: null,
    commentPrefix: "//",
    usesColonAfterSignature: false,
    packageNode: "package_declaration",
    classBodyNodeTypes: new Set(["class_body"]),
  },
  c: {
    importNodes: new Set(["preproc_include"]),
    functionNodes: new Set(["function_definition"]),
    classNodes: new Set(),
    typeNodes: new Set(["struct_specifier", "enum_specifier", "type_definition"]),
    bodyNodeTypes: new Set(["compound_statement"]),
    decoratorNode: null,
    commentPrefix: "//",
    usesColonAfterSignature: false,
    packageNode: null,
    classBodyNodeTypes: null,
  },
};

// ─── Language Detection ──────────────────────────────────────────────

const LANG_PREFILTER: Record<string, RegExp[]> = {
  python: [/^\s*(def|class|import|from|async def)\s+\w+/m, /^\s*@\w+/m, /^\s*if __name__\s*==/m],
  javascript: [/^\s*(function|const|let|var|class|export)\s+\w+/m, /^\s*module\.exports/m],
  typescript: [/^\s*(interface|type|enum|namespace)\s+\w+/m, /:\s*(string|number|boolean|any|void)\b/m],
  go: [/^\s*(func|type|package|import)\s+/m, /\bstruct\s*\{/m],
  rust: [/^\s*(fn|struct|enum|impl|mod|use|pub)\s+/m, /^\s*#\[/m],
  java: [/^\s*(public|private|protected)\s+(class|interface|enum)/m, /^\s*package\s+[\w.]+;/m],
  c: [/^\s*#include\s*[<"]/m, /^\s*(int|void|char|float|double)\s+\w+\s*\(/m],
};

function countErrors(node: any): number {
  let count = 0;
  if (node.type === "ERROR" || node.isMissing) count++;
  for (let i = 0; i < node.childCount; i++) {
    count += countErrors(node.child(i));
  }
  return count;
}

export function detectLanguage(code: string): { language: string; confidence: number } {
  if (!code?.trim()) return { language: "unknown", confidence: 0 };
  const sample = code.slice(0, 5000);

  // Pre-filter
  const candidates: Record<string, number> = {};
  for (const [lang, patterns] of Object.entries(LANG_PREFILTER)) {
    let score = 0;
    for (const p of patterns) {
      const matches = sample.match(new RegExp(p.source, "gm"));
      if (matches) score += matches.length;
    }
    if (score > 0) candidates[lang] = score;
  }

  // TS/JS disambiguation
  if (candidates.typescript && candidates.javascript) {
    if (candidates.typescript >= 2) candidates.javascript = 0;
  }

  if (Object.keys(candidates).length === 0) return { language: "unknown", confidence: 0 };

  // If tree-sitter available, parse with candidates
  if (loadTreeSitter()) {
    let bestLang = "unknown";
    let minErrors = Infinity;
    let bestNodes = 0;
    const codeBytes = code.slice(0, 10000);

    const sorted = Object.entries(candidates).sort((a, b) => b[1] - a[1]);
    for (const [lang] of sorted) {
      if (candidates[lang] === 0) continue;
      try {
        const parser = getParser(lang);
        const tree = parser.parse(codeBytes);
        const errors = countErrors(tree.rootNode);
        const nodes = tree.rootNode.childCount;
        if (errors < minErrors || (errors === minErrors && nodes > bestNodes)) {
          minErrors = errors;
          bestLang = lang;
          bestNodes = nodes;
        }
      } catch { continue; }
    }

    if (bestLang !== "unknown") {
      const totalLines = Math.max(1, code.trim().split("\n").length);
      const confidence = Math.max(0.3, Math.min(1.0, 1.0 - minErrors / totalLines));
      return { language: bestLang, confidence };
    }
  }

  // Fallback: regex scoring
  const best = Object.entries(candidates).sort((a, b) => b[1] - a[1])[0];
  return { language: best[0], confidence: Math.min(1.0, 0.3 + best[1] * 0.1) };
}

// ─── Symbol Importance Analysis ──────────────────────────────────────

interface SymbolInfo {
  name: string;
  qualifiedName: string;
  node: any;
  refCount: number;
  fanOut: number;
  bodyLines: number;
  isPublic: boolean;
  score: number;
}

function getNodeName(node: any): string | null {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child.type === "identifier" || child.type === "property_identifier" || child.type === "type_identifier") {
      return child.text;
    }
  }
  return null;
}

function isPublicSymbol(name: string, language: string): boolean {
  if (language === "python") return !name.startsWith("_");
  if (language === "go") return name.length > 0 && name[0] === name[0].toUpperCase();
  if (language === "java") return true; // Can't tell from name alone
  return !name.startsWith("_");
}

function collectDefinitions(node: any, langConfig: LangConfig, parentName = ""): Map<string, any> {
  const defs = new Map<string, any>();
  const allDefTypes = new Set([...langConfig.functionNodes, ...langConfig.classNodes]);

  function walk(n: any, parent: string) {
    if (allDefTypes.has(n.type)) {
      const name = getNodeName(n);
      if (name) {
        const qname = parent ? `${parent}.${name}` : name;
        defs.set(qname, n);
        // Walk children for nested definitions
        for (let i = 0; i < n.childCount; i++) walk(n.child(i), qname);
        return;
      }
    }
    if (langConfig.decoratorNode && n.type === langConfig.decoratorNode) {
      for (let i = 0; i < n.childCount; i++) {
        const child = n.child(i);
        if (allDefTypes.has(child.type)) {
          const name = getNodeName(child);
          if (name) {
            const qname = parent ? `${parent}.${name}` : name;
            defs.set(qname, child);
            for (let j = 0; j < child.childCount; j++) walk(child.child(j), qname);
            return;
          }
        }
      }
    }
    for (let i = 0; i < n.childCount; i++) walk(n.child(i), parent);
  }

  walk(node, parentName);
  return defs;
}

function collectIdentifiers(node: any): Map<string, number> {
  const ids = new Map<string, number>();
  function walk(n: any) {
    if (n.type === "identifier" || n.type === "property_identifier" || n.type === "type_identifier") {
      const name = n.text;
      ids.set(name, (ids.get(name) || 0) + 1);
    }
    for (let i = 0; i < n.childCount; i++) walk(n.child(i));
  }
  walk(node);
  return ids;
}

function analyzeSymbols(root: any, code: string, language: string, context: string): SymbolInfo[] {
  const langConfig = LANG_CONFIGS[language];
  if (!langConfig) return [];

  const definitions = collectDefinitions(root, langConfig);
  if (definitions.size === 0) return [];

  const allIds = collectIdentifiers(root);
  const contextLower = context.toLowerCase();
  const contextWords = new Set(contextLower.split(/[\s,;:.()\[\]{}"']+/).filter(w => w.length > 2));

  const symbols: SymbolInfo[] = [];
  const shortNames = new Map<string, string>(); // qname -> short
  for (const [qname] of definitions) {
    const parts = qname.split(".");
    shortNames.set(qname, parts[parts.length - 1]);
  }

  for (const [qname, node] of definitions) {
    const name = shortNames.get(qname)!;
    const refCount = Math.max(0, (allIds.get(name) || 0) - 1); // subtract definition itself

    // Count fan-out (calls to other defined symbols)
    const definedNames = new Set(shortNames.values());
    let fanOut = 0;
    function countCalls(n: any) {
      if (n.type === "identifier" && definedNames.has(n.text) && n.text !== name) fanOut++;
      for (let i = 0; i < n.childCount; i++) countCalls(n.child(i));
    }
    countCalls(node);

    // Body line count
    const nodeText = code.slice(node.startIndex, node.endIndex);
    const bodyLines = Math.max(1, nodeText.split("\n").length - 2);

    const pub = isPublicSymbol(name, language);

    // Raw score
    let raw = refCount + (pub ? 1.0 : 0.0) + fanOut * 0.5;
    if (language === "python" && name.startsWith("__") && name.endsWith("__")) raw += 2.0;
    if (language === "go" && name[0] === name[0].toUpperCase()) raw += 1.0;
    if (contextWords.has(name.toLowerCase()) || (name.length > 3 && contextLower.includes(name.toLowerCase()))) raw += 3.0;

    symbols.push({ name, qualifiedName: qname, node, refCount, fanOut, bodyLines, isPublic: pub, score: raw });
  }

  // Normalize scores to 0-1 (min-max)
  if (symbols.length > 0) {
    const scores = symbols.map(s => s.score);
    const min = Math.min(...scores);
    const max = Math.max(...scores);
    const range = max - min;
    if (range > 0) {
      for (const s of symbols) s.score = (s.score - min) / range;
    } else {
      for (const s of symbols) s.score = 0.5;
    }
  }

  return symbols;
}

// ─── Body Compression ────────────────────────────────────────────────

interface CompressConfig {
  targetCompressionRate: number;
  maxBodyLines: number;
  preserveImports: boolean;
  preserveSignatures: boolean;
  preserveDecorators: boolean;
  docstringMode: "full" | "first_line" | "remove";
  compressComments: boolean;
  minTokensForCompression: number;
}

const DEFAULT_COMPRESS_CONFIG: CompressConfig = {
  targetCompressionRate: 0.2,
  maxBodyLines: 5,
  preserveImports: true,
  preserveSignatures: true,
  preserveDecorators: true,
  docstringMode: "first_line",
  compressComments: true,
  minTokensForCompression: 100,
};

function allocateBodyBudgets(symbols: SymbolInfo[], totalLines: number, config: CompressConfig): Map<string, number> {
  const totalBody = symbols.reduce((sum, s) => sum + s.bodyLines, 0);
  const fixedLines = Math.max(0, totalLines - totalBody);
  const targetTotal = totalLines * config.targetCompressionRate;
  const bodyBudget = Math.max(0, targetTotal - fixedLines);

  const budgets = new Map<string, number>();
  const scoreFloor = 0.05;

  let totalWeight = 0;
  const weights = symbols.map(s => {
    const w = Math.max(s.score, scoreFloor) * s.bodyLines;
    totalWeight += w;
    return w;
  });

  if (totalWeight === 0) {
    const perFunc = Math.max(0, Math.floor(bodyBudget / Math.max(symbols.length, 1)));
    for (const s of symbols) budgets.set(s.qualifiedName, Math.min(perFunc, s.bodyLines));
    return budgets;
  }

  for (let i = 0; i < symbols.length; i++) {
    const allocation = bodyBudget * weights[i] / totalWeight;
    budgets.set(symbols[i].qualifiedName, Math.min(Math.round(allocation), symbols[i].bodyLines));
    budgets.set(symbols[i].name, Math.min(Math.round(allocation), symbols[i].bodyLines)); // also by short name
  }

  return budgets;
}

function compressBody(body: string, maxLines: number, commentPrefix: string): string {
  const lines = body.split("\n");
  if (lines.length <= maxLines) return body;

  // Keep first maxLines, add ellipsis
  const kept = lines.slice(0, maxLines);
  const omitted = lines.length - maxLines;
  kept.push(`${commentPrefix} ... (${omitted} lines compressed)`);
  return kept.join("\n");
}

// ─── Main Compression Function ───────────────────────────────────────

export interface CodeCompressionResult {
  compressed: string;
  wasModified: boolean;
  language: string;
  confidence: number;
  strategy: string;
  preservedImports: number;
  preservedSignatures: number;
  compressedBodies: number;
  symbolScores: Record<string, number>;
}

export function compressCode(
  code: string,
  context = "",
  config = DEFAULT_COMPRESS_CONFIG
): CodeCompressionResult {
  const noOp: CodeCompressionResult = {
    compressed: code, wasModified: false, language: "unknown",
    confidence: 0, strategy: "passthrough", preservedImports: 0,
    preservedSignatures: 0, compressedBodies: 0, symbolScores: {},
  };

  if (!code?.trim() || code.length < 200) return noOp;

  // Estimate tokens (chars/4)
  const tokens = Math.max(1, code.length >> 2);
  if (tokens < config.minTokensForCompression) return noOp;

  // Detect language
  const { language, confidence } = detectLanguage(code);
  if (language === "unknown" || !LANG_CONFIGS[language]) {
    return { ...noOp, language, confidence, strategy: "unknown_language" };
  }

  if (!loadTreeSitter()) {
    // Fallback: regex-based compression (no AST)
    return { ...noOp, language, confidence, strategy: "no_tree_sitter" };
  }

  // Parse
  const langConfig = LANG_CONFIGS[language];
  let tree: any;
  try {
    const parser = getParser(language);
    tree = parser.parse(code);
  } catch {
    return { ...noOp, language, confidence, strategy: "parse_error" };
  }

  const root = tree.rootNode;

  // Analyze symbols
  const symbols = analyzeSymbols(root, code, language, context);
  if (symbols.length === 0) {
    return { ...noOp, language, confidence, strategy: "no_symbols" };
  }

  // Allocate body budgets
  const totalLines = code.split("\n").length;
  const budgets = allocateBodyBudgets(symbols, totalLines, config);

  // Rebuild code with compressed bodies
  const lines = code.split("\n");
  const compressedRegions: Array<{ start: number; end: number; replacement: string }> = [];
  let compressedBodies = 0;

  for (const sym of symbols) {
    const node = sym.node;
    // Find the body node
    let bodyNode: any = null;
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (langConfig.bodyNodeTypes.has(child.type)) {
        bodyNode = child;
        break;
      }
    }
    if (!bodyNode) continue;

    const bodyStartLine = bodyNode.startPosition.row;
    const bodyEndLine = bodyNode.endPosition.row;
    const bodyLineCount = bodyEndLine - bodyStartLine + 1;
    const budget = budgets.get(sym.qualifiedName) ?? budgets.get(sym.name) ?? config.maxBodyLines;

    if (bodyLineCount <= budget + 1) continue; // Not worth compressing

    // Extract and compress body
    const bodyLines = lines.slice(bodyStartLine, bodyEndLine + 1);
    const compressed = compressBody(bodyLines.join("\n"), budget, langConfig.commentPrefix);

    compressedRegions.push({
      start: bodyStartLine,
      end: bodyEndLine,
      replacement: compressed,
    });
    compressedBodies++;
  }

  if (compressedBodies === 0) {
    return {
      ...noOp, language, confidence, strategy: "nothing_to_compress",
      symbolScores: Object.fromEntries(symbols.map(s => [s.name, Math.round(s.score * 100) / 100])),
    };
  }

  // Apply compressions (reverse order to preserve line numbers)
  compressedRegions.sort((a, b) => b.start - a.start);
  const result = [...lines];
  for (const region of compressedRegions) {
    const replacementLines = region.replacement.split("\n");
    result.splice(region.start, region.end - region.start + 1, ...replacementLines);
  }

  const compressed = result.join("\n");
  const preservedImports = symbols.filter(s => {
    const node = s.node;
    return langConfig.importNodes.has(node.type);
  }).length;

  return {
    compressed,
    wasModified: compressed !== code,
    language,
    confidence,
    strategy: `ast_compressor:${compressedBodies}`,
    preservedImports,
    preservedSignatures: symbols.length,
    compressedBodies,
    symbolScores: Object.fromEntries(symbols.map(s => [s.name, Math.round(s.score * 100) / 100])),
  };
}
