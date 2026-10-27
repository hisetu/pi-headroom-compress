/** Shared request text helpers used by the extension hook. */

import { capCompressedOutput, extractPreservableCCRMarker, isCCRReferenceContent } from "./ccr-store.ts";
import { tryParseJsonArray } from "./json-array-utils.ts";

export interface InputItem {
  role?: string;
  type?: string;
  content?: string | unknown[];
  output?: string;
  phase?: string;
  [key: string]: unknown;
}

interface ContentBlock {
  type?: string;
  text?: string;
  [key: string]: unknown;
}

function isTextBlock(block: ContentBlock): boolean {
  return typeof block.text === "string" &&
    (block.type === undefined || block.type === "text" || block.type === "input_text" || block.type === "output_text");
}

export function isInstructionMessageItem(item: InputItem): boolean {
  return (item.type === undefined || item.type === "message") &&
    (item.role === "developer" || item.role === "system") &&
    typeof item.content === "string";
}

export function getItemText(item: InputItem): string {
  if (typeof item.output === "string") return item.output;
  if (typeof item.content === "string") return item.content;
  if (Array.isArray(item.content)) {
    return (item.content as ContentBlock[])
      .filter(isTextBlock)
      .map((block) => block.text as string)
      .join("\n");
  }
  return "";
}

export function setItemText(item: InputItem, text: string): InputItem {
  if (typeof item.output === "string") return { ...item, output: text };
  if (typeof item.content === "string") return { ...item, content: text };
  if (Array.isArray(item.content)) {
    let replaced = false;
    const newContent = (item.content as ContentBlock[]).flatMap((block) => {
      if (isTextBlock(block)) {
        if (!replaced) {
          replaced = true;
          return [{ ...block, text }];
        }
        return [];
      }
      return [block];
    });
    if (!replaced) return item;
    return { ...item, content: newContent };
  }
  return item;
}

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
}

function deduplicateConsecutiveLines(text: string): string {
  const lines = text.split("\n");
  if (lines.length < 10) return text;
  const result: string[] = [];
  let lastLine = "", dupeCount = 0;
  for (const line of lines) {
    if (line === lastLine) { dupeCount++; }
    else {
      if (dupeCount > 2) result.push(`  ... (${dupeCount} identical lines omitted)`);
      else for (let i = 0; i < dupeCount; i++) result.push(lastLine);
      result.push(line);
      dupeCount = 0;
      lastLine = line;
    }
  }
  if (dupeCount > 2) result.push(`  ... (${dupeCount} identical lines omitted)`);
  else for (let i = 0; i < dupeCount; i++) result.push(lastLine);
  return result.join("\n");
}

export function preprocessToolOutput(text: string): string {
  const cleaned = stripAnsi(text);
  if (tryParseJsonArray(cleaned.trim())) return cleaned;
  return deduplicateConsecutiveLines(cleaned);
}

export { capCompressedOutput, extractPreservableCCRMarker, isCCRReferenceContent };
