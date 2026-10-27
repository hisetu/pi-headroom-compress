import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { CCRStore, isValidCCRHash } from "./ccr-store.ts";

export const DEFAULT_CCR_RETRIEVE_LIMIT = 4_000;
export const MAX_CCR_RETRIEVE_LIMIT = 12_000;

export interface CCRRetrieveInput {
  hash: string;
  offset?: number;
  limit?: number;
}

export interface CCRRetrieveSegment {
  ok: true;
  hash: string;
  content: string;
  offset: number;
  returnedChars: number;
  totalChars: number;
  nextOffset: number | null;
  hasMore: boolean;
  strategy?: string;
  toolName?: string;
  retrievalCount: number;
}

export interface CCRRetrieveFailure {
  ok: false;
  code: "invalid_hash" | "invalid_range" | "unavailable";
  hash: string;
  message: string;
}

export type CCRRetrieveResult = CCRRetrieveSegment | CCRRetrieveFailure;
export type CCRRetrieveToolDetails = Omit<CCRRetrieveSegment, "content"> | CCRRetrieveFailure;

/** Retrieve one bounded segment without exposing the complete original in tool details. */
export function retrieveCCRSegment(store: CCRStore, input: CCRRetrieveInput): CCRRetrieveResult {
  const hash = typeof input.hash === "string" ? input.hash : "";
  if (!isValidCCRHash(hash)) {
    return {
      ok: false,
      code: "invalid_hash",
      hash,
      message: "Invalid CCR hash. Expected 12 or 24 lowercase hexadecimal characters.",
    };
  }

  const offset = input.offset ?? 0;
  const requestedLimit = input.limit ?? DEFAULT_CCR_RETRIEVE_LIMIT;
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(requestedLimit) || requestedLimit < 1) {
    return {
      ok: false,
      code: "invalid_range",
      hash,
      message: "CCR offset must be a non-negative integer and limit must be a positive integer.",
    };
  }

  const entry = store.retrieve(hash);
  if (!entry) {
    return {
      ok: false,
      code: "unavailable",
      hash,
      message: `CCR content unavailable for hash ${hash}. It may have expired or been evicted; re-run the original tool or read.`,
    };
  }

  const limit = Math.min(requestedLimit, MAX_CCR_RETRIEVE_LIMIT);
  const totalChars = entry.original.length;
  const safeOffset = Math.min(offset, totalChars);
  const content = entry.original.slice(safeOffset, safeOffset + limit);
  const nextOffset = safeOffset + content.length < totalChars ? safeOffset + content.length : null;

  return {
    ok: true,
    hash,
    content,
    offset: safeOffset,
    returnedChars: content.length,
    totalChars,
    nextOffset,
    hasMore: nextOffset !== null,
    strategy: entry.strategy,
    toolName: entry.toolName,
    retrievalCount: entry.retrievalCount,
  };
}

/** Wrap retrieved text so the request compressor can identify and preserve it exactly. */
export function formatCCRRetrievedContent(segment: CCRRetrieveSegment): string {
  const next = segment.nextOffset ?? "end";
  return [
    `⟨ccr-retrieved:${segment.hash} offset=${segment.offset} returned=${segment.returnedChars} total=${segment.totalChars} next=${next}⟩`,
    segment.content,
    `⟨/ccr-retrieved:${segment.hash}⟩`,
  ].join("\n");
}

/** Validate the complete retrieval envelope, including its declared content length. */
export function isCCRRetrievedContent(text: string): boolean {
  const match = text.match(
    /^⟨ccr-retrieved:([0-9a-f]{12}|[0-9a-f]{24}) offset=(\d+) returned=(\d+) total=(\d+) next=(\d+|end)⟩\n([\s\S]*)\n⟨\/ccr-retrieved:\1⟩$/,
  );
  if (!match) return false;

  const offset = Number(match[2]);
  const returned = Number(match[3]);
  const total = Number(match[4]);
  const next = match[5] === "end" ? null : Number(match[5]);
  const content = match[6];
  if (![offset, returned, total].every(Number.isSafeInteger)) return false;
  if (offset > total || returned !== content.length || offset + returned > total) return false;
  return next === null ? offset + returned === total : next === offset + returned && next < total;
}

const RetrieveParams = Type.Object({
  hash: Type.String({
    pattern: "^(?:[0-9a-f]{12}|[0-9a-f]{24})$",
    description: "Hash from a ⟨ccr:...⟩ marker",
  }),
  offset: Type.Optional(Type.Integer({
    minimum: 0,
    description: "Character offset to start reading from; defaults to 0",
  })),
  limit: Type.Optional(Type.Integer({
    minimum: 1,
    maximum: MAX_CCR_RETRIEVE_LIMIT,
    description: `Maximum characters to return; defaults to ${DEFAULT_CCR_RETRIEVE_LIMIT}`,
  })),
});

export function registerHeadroomRetrieveTool(pi: ExtensionAPI, store: CCRStore): void {
  pi.registerTool<typeof RetrieveParams, CCRRetrieveToolDetails>({
    name: "headroom_retrieve",
    label: "Headroom Retrieve",
    description:
      "Retrieve a bounded segment of original content referenced by a ⟨ccr:...⟩ marker. " +
      "Use this only when omitted details are needed. Page with offset and limit instead of requesting the whole value.",
    exposure: "direct",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    parameters: RetrieveParams,
    async execute(_toolCallId, params) {
      const result = retrieveCCRSegment(store, params);
      if (result.ok === false) {
        return {
          content: [{ type: "text", text: result.message }],
          details: result,
          isError: true,
        };
      }

      return {
        content: [{ type: "text", text: formatCCRRetrievedContent(result) }],
        details: {
          ok: true,
          hash: result.hash,
          offset: result.offset,
          returnedChars: result.returnedChars,
          totalChars: result.totalChars,
          nextOffset: result.nextOffset,
          hasMore: result.hasMore,
          strategy: result.strategy,
          toolName: result.toolName,
          retrievalCount: result.retrievalCount,
        },
      };
    },
  });
}
