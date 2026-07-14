/**
 * Output Shaper — Reduce output tokens by reshaping the request
 * 
 * Two levers:
 * 1. Verbosity steering: append instruction to system prompt telling LLM
 *    to be concise (skip preamble, don't restate code, etc.)
 * 2. Effort routing: on mechanical continuations (tool success → continue),
 *    lower thinking effort since the model is just doing routine work
 * 
 * Safety rules:
 * - Never inject effort/thinking where the client didn't send it
 * - Steering text is byte-stable and idempotent
 * - Never modify user messages or tool results
 * 
 * Mirrors: headroom/proxy/output_shaper.py
 */

// ─── Verbosity Levels ────────────────────────────────────────────────

const STEERING_SENTINEL = "<headroom_output_shaping>";
const STEERING_SUFFIX = "</headroom_output_shaping>";

// Cumulative levels: each includes everything above
const VERBOSITY_LEVELS: Record<number, string> = {
  1: "Skip preamble and postamble. Do not announce what you are about to do or recap what you just did; start with the substance.",
  2: "Skip preamble and postamble; start with the substance. Never restate code, file contents, diffs, or tool output that already appear in this conversation — reference them by path and line instead. After a tool call succeeds, continue without narrating the result.",
  3: "Skip preamble and postamble. Never restate code, file contents, diffs, or tool output already in this conversation — reference by path and line. Give conclusions only; omit rationale unless the user asks why. Prefer the smallest edit over rewriting whole files. Keep prose to the minimum needed to be unambiguous.",
  4: "Minimum tokens. Fragments fine. No preamble, no postamble, no restating context, no rationale. Answer, smallest-possible edits, nothing else.",
};

// ─── Turn Classification ─────────────────────────────────────────────

type TurnKind = "new_user_ask" | "mechanical_continuation" | "error_continuation" | "unknown";

interface InputItem {
  role?: string;
  type?: string;
  content?: string | unknown[];
  output?: string;
  is_error?: boolean;
  [key: string]: unknown;
}

/**
 * Classify the latest turn from message structure alone.
 * - User text/image → new ask (full effort)
 * - Only tool outputs, no errors → mechanical continuation (reduce effort)
 * - Tool output with error → error continuation (keep full effort)
 */
export function classifyTurn(items: InputItem[]): TurnKind {
  if (items.length === 0) return "unknown";

  // Look at the tail items (after last user message)
  // In OpenAI Responses format, we look at the most recent items
  const lastUserIdx = items.findLastIndex((item) => item.role === "user");
  if (lastUserIdx === -1) return "unknown";

  const lastUserItem = items[lastUserIdx];

  // Check if user sent text (new ask)
  const userContent = lastUserItem.content;
  if (typeof userContent === "string" && userContent.trim()) return "new_user_ask";
  if (Array.isArray(userContent)) {
    for (const block of userContent as Array<Record<string, unknown>>) {
      if (block.type === "input_text" || block.type === "text" || block.type === "image") {
        return "new_user_ask";
      }
    }
  }

  // Check items after last user message
  const afterUser = items.slice(lastUserIdx + 1);
  let sawToolOutput = false;
  let sawError = false;

  for (const item of afterUser) {
    if (item.type === "function_call_output") {
      sawToolOutput = true;
      if (item.is_error === true) sawError = true;
      // Check output for error indicators
      if (typeof item.output === "string" && /^(Error|error|ERROR|FAIL|Exception)/m.test(item.output)) {
        sawError = true;
      }
    }
  }

  if (sawError) return "error_continuation";
  if (sawToolOutput) return "mechanical_continuation";
  return "unknown";
}

// ─── Effort Routing ──────────────────────────────────────────────────

const EFFORT_RANK: Record<string, number> = { low: 0, medium: 1, high: 2, xhigh: 3, max: 4 };

interface OutputShaperConfig {
  enabled: boolean;
  verbosityLevel: number;
  effortRouterEnabled: boolean;
  mechanicalEffort: string; // "low" | "medium"
}

export const DEFAULT_OUTPUT_SHAPER_CONFIG: OutputShaperConfig = {
  enabled: true,
  verbosityLevel: 2,
  effortRouterEnabled: true,
  mechanicalEffort: "low",
};

export interface ShapeResult {
  payload: Record<string, unknown>;
  changed: boolean;
  labels: string[];
}

/**
 * Apply output shaping to an OpenAI Responses API payload.
 */
export function shapeOutput(
  payload: Record<string, unknown>,
  config = DEFAULT_OUTPUT_SHAPER_CONFIG
): ShapeResult {
  if (!config.enabled) return { payload, changed: false, labels: [] };

  const result: ShapeResult = { payload: { ...payload }, changed: false, labels: [] };
  const items = (result.payload.input ?? []) as InputItem[];

  // 1. Verbosity steering — append to developer/system prompt
  if (config.verbosityLevel > 0) {
    const steeringApplied = applyVerbositySteering(items, config.verbosityLevel);
    if (steeringApplied) {
      result.changed = true;
      result.labels.push(`output_shaper:verbosity:L${config.verbosityLevel}`);
    }
  }

  // 2. Effort routing — lower effort on mechanical continuations
  if (config.effortRouterEnabled) {
    const kind = classifyTurn(items);
    if (kind === "mechanical_continuation") {
      const effortLabels = routeEffort(result.payload, config);
      if (effortLabels.length > 0) {
        result.changed = true;
        result.labels.push(...effortLabels);
      }
    }
  }

  if (result.changed) {
    result.payload.input = items;
  }

  return result;
}

// ─── Internal: Verbosity Steering ────────────────────────────────────

function applyVerbositySteering(items: InputItem[], level: number): boolean {
  const text = VERBOSITY_LEVELS[level];
  if (!text) return false;

  const steeringBlock = `${STEERING_SENTINEL}\n${text}\n${STEERING_SUFFIX}`;

  // Find the developer/system prompt item
  const devIdx = items.findIndex((item) => item.role === "developer");
  if (devIdx === -1) return false;

  const devItem = items[devIdx];
  const content = typeof devItem.content === "string" ? devItem.content : "";

  // Check if already applied
  if (content.includes(STEERING_SENTINEL)) {
    // Check if same level
    if (content.includes(text)) return false;
    // Level changed — replace existing block
    const start = content.indexOf(STEERING_SENTINEL);
    const end = content.indexOf(STEERING_SUFFIX) + STEERING_SUFFIX.length;
    const newContent = content.slice(0, start) + steeringBlock + content.slice(end);
    items[devIdx] = { ...devItem, content: newContent };
    return true;
  }

  // Append steering to end of developer prompt
  items[devIdx] = { ...devItem, content: content + "\n\n" + steeringBlock };
  return true;
}

// ─── Internal: Effort Routing ────────────────────────────────────────

function routeEffort(payload: Record<string, unknown>, config: OutputShaperConfig): string[] {
  const labels: string[] = [];

  // OpenAI Responses API: check "reasoning" field
  const reasoning = payload.reasoning as Record<string, unknown> | undefined;
  if (reasoning && typeof reasoning === "object") {
    const effort = reasoning.effort as string | undefined;
    if (
      effort &&
      effort in EFFORT_RANK &&
      EFFORT_RANK[effort] > EFFORT_RANK[config.mechanicalEffort]
    ) {
      (payload.reasoning as Record<string, unknown>).effort = config.mechanicalEffort;
      labels.push(`output_shaper:effort:${effort}->${config.mechanicalEffort}`);
    }
  }

  return labels;
}
