// Canonical terminal projection shared by OpenAI-compatible HTTP surfaces.
import {
  buildAgentRunTerminalOutcomeFromLifecycleEvent,
  mergeAgentRunTerminalOutcome,
  type AgentRunTerminalOutcome,
} from "../agents/agent-run-terminal-outcome.js";
import {
  isReplyPayloadTerminalContent,
  type ReplyPayload,
} from "../auto-reply/reply-payload.js";

type LifecycleData = NonNullable<
  Parameters<typeof buildAgentRunTerminalOutcomeFromLifecycleEvent>[0]["data"]
>;

type OpenAiHttpAgentResult = {
  payloads?: ReplyPayload[];
  meta?: LifecycleData & { pendingToolCalls?: unknown };
};

type OpenAiHttpReplyPayload = ReplyPayload & { visible?: unknown };

function isVisibleTerminalPayload(payload: OpenAiHttpReplyPayload): boolean {
  if (payload.isError === true) {
    return true;
  }
  if (
    !isReplyPayloadTerminalContent(payload) ||
    payload.isReasoningSnapshot === true ||
    // Older agent results may carry the pre-ReplyPayload visibility projection.
    payload.visible === false
  ) {
    return false;
  }
  return typeof payload.text === "string" && payload.text.trim().length > 0;
}

/** Return model-visible result text without leaking historical error payloads. */
export function resolveOpenAiHttpResultText(result: unknown): string {
  // SAFETY: callers pass agent results or nullish terminal outcomes through this shared projector.
  const payloads = (result as OpenAiHttpAgentResult | null | undefined)?.payloads;
  return Array.isArray(payloads)
    ? payloads
        .filter(
          (payload) => payload.isError !== true && isVisibleTerminalPayload(payload),
        )
        .map((payload) => (typeof payload.text === "string" ? payload.text : ""))
        .filter(Boolean)
        .join("\n\n")
    : "";
}

/** Preserve real provider failures even when the agent resolves its result. */
export function resolveOpenAiHttpAgentRunTerminalOutcome(
  result: unknown,
  previous?: AgentRunTerminalOutcome,
): AgentRunTerminalOutcome {
  // SAFETY: callers pass agent results or nullish terminal outcomes through this shared projector.
  const agentResult = result as OpenAiHttpAgentResult | null | undefined;
  const meta = agentResult?.meta;
  const completedToolCall =
    meta?.stopReason === "tool_calls" &&
    Array.isArray(meta.pendingToolCalls) &&
    meta.pendingToolCalls.length > 0;
  // Completed tool calls can intentionally make a successful turn unsafe to
  // replay. Replay safety alone is not a provider or terminal-run failure.
  // Only the last real visible/error payload owns recovered fallback state.
  const terminalPayload = agentResult?.payloads?.findLast(isVisibleTerminalPayload);
  return mergeAgentRunTerminalOutcome(
    previous,
    buildAgentRunTerminalOutcomeFromLifecycleEvent({
      phase:
        meta?.error != null || (!completedToolCall && terminalPayload?.isError === true)
          ? "error"
          : "end",
      data: meta,
    }),
  );
}
