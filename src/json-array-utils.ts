/**
 * JSON array detection helpers — space-separated object runs and array parsing.
 * Inspired by headroom/transforms/content_detector.py (#1741).
 */

function parseJsonObjectAt(text: string, start: number): { value: unknown; end: number } {
  if (text[start] !== "{") {
    throw new SyntaxError("expected object");
  }

  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i]!;
    if (inString) {
      if (escape) escape = false;
      else if (ch === "\\") escape = true;
      else if (ch === "\"") inString = false;
      continue;
    }
    if (ch === "\"") {
      inString = true;
      continue;
    }
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        const end = i + 1;
        return { value: JSON.parse(text.slice(start, end)), end };
      }
    }
  }
  throw new SyntaxError("unterminated JSON object");
}

export function decodeConcatenatedJson(content: string): unknown[] | null {
  const trimmed = content.trim();
  if (!trimmed.startsWith("{")) return null;

  const items: unknown[] = [];
  let index = 0;

  while (index < trimmed.length) {
    while (index < trimmed.length && /\s/.test(trimmed[index]!)) index++;
    if (index >= trimmed.length) break;
    if (trimmed[index] !== "{") return null;

    try {
      const parsed = parseJsonObjectAt(trimmed, index);
      items.push(parsed.value);
      index = parsed.end;
    } catch {
      return null;
    }
  }

  return items.length > 0 ? items : null;
}

export function normalizeConcatenatedJson(content: string): string | null {
  const trimmed = content.trim();
  if (!trimmed.startsWith("{")) return null;

  const items = decodeConcatenatedJson(trimmed);
  if (items && items.length >= 2 && items.every((item) => typeof item === "object" && item !== null && !Array.isArray(item))) {
    return JSON.stringify(items);
  }
  return null;
}

export function tryParseJsonArray(content: string): { items: unknown[]; isDictArray: boolean; concatenated?: boolean } | null {
  const trimmed = content.trim();

  if (trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (!Array.isArray(parsed)) return null;
      const isDictArray = parsed.length > 0
        && parsed.every((item) => typeof item === "object" && item !== null && !Array.isArray(item));
      return { items: parsed, isDictArray };
    } catch {
      return null;
    }
  }

  if (trimmed.startsWith("{")) {
    const items = decodeConcatenatedJson(trimmed);
    if (items && items.length >= 2 && items.every((item) => typeof item === "object" && item !== null && !Array.isArray(item))) {
      return { items, isDictArray: true, concatenated: true };
    }
  }

  return null;
}
