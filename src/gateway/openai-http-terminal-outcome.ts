// Canonical terminal projection shared by OpenAI-compatible HTTP surfaces.
import {
  buildAgentRunTerminalOutcomeFromLifecycleEvent,
  mergeAgentRunTerminalOutcome,
  type AgentRunTerminalOutcome,
} from "../agents/agent-run-terminal-outcome.js";
import { hasVisibleAgentPayload } from "../agents/embedded-agent-runner/message-visibility.js";
import { isReplyPayloadStatusNotice, type ReplyPayload } from "../auto-reply/reply-payload.js";

type LifecycleData = NonNullable<
  Parameters<typeof buildAgentRunTerminalOutcomeFromLifecycleEvent>[0]["data"]
>;

type OpenAiHttpAgentResult = {
  payloads?: ReplyPayload[];
  meta?: LifecycleData;
};

function isTerminalPayload(payload: ReplyPayload): boolean {
  if (payload.isError === true) {
    return true;
  }
  if (
    payload.isCommentary === true ||
    payload.isReasoningSnapshot === true ||
    isReplyPayloadStatusNotice(payload) ||
    (payload as ReplyPayload & { visible?: unknown }).visible === false
  ) {
    return false;
  }
  return hasVisibleAgentPayload(
    { payloads: [payload] },
    {
      includeErrorPayloads: false,
      includeReasoningPayloads: false,
      includeSilentReplyPayloads: false,
    },
  );
}

/** Return model-visible result text without leaking historical error payloads. */
export function resolveOpenAiHttpResultText(result: unknown): string {
  const payloads = (result as OpenAiHttpAgentResult | null | undefined)?.payloads;
  return Array.isArray(payloads)
    ? payloads
        .filter((payload) => payload.isError !== true)
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
  const agentResult = result as OpenAiHttpAgentResult | null | undefined;
  const meta = agentResult?.meta;
  // Completed tool calls can intentionally make a successful turn unsafe to
  // replay. Replay safety alone is not a provider or terminal-run failure.
  // Only the last real visible/error payload owns recovered fallback state.
  const terminalPayload = agentResult?.payloads?.findLast(isTerminalPayload);
  return mergeAgentRunTerminalOutcome(
    previous,
    buildAgentRunTerminalOutcomeFromLifecycleEvent({
      phase: meta?.error != null || terminalPayload?.isError === true ? "error" : "end",
      data: meta,
    }),
  );
}
