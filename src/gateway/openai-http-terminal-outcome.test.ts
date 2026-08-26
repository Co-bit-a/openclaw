import { describe, expect, it } from "vitest";
import {
  resolveOpenAiHttpAgentRunTerminalOutcome,
  resolveOpenAiHttpResultText,
} from "./openai-http-terminal-outcome.js";

describe("OpenAI HTTP terminal outcome", () => {
  it.each([
    {
      name: "accepts a visible fallback after a failed attempt",
      result: {
        payloads: [
          { text: "private provider failure", isError: true },
          { text: "fallback recovered" },
        ],
      },
      reason: "completed",
    },
    {
      name: "accepts a tool-call fallback after a failed attempt",
      result: {
        payloads: [{ text: "private provider failure", isError: true }],
        meta: {
          stopReason: "tool_calls",
          pendingToolCalls: [{ id: "call_1", name: "search", arguments: "{}" }],
        },
      },
      reason: "completed",
    },
    {
      name: "retains failure when only unrepresentable media follows",
      result: {
        payloads: [
          { text: "private provider failure", isError: true },
          { mediaUrl: "https://example.invalid/recovered.png" },
        ],
      },
      reason: "failed",
    },
    {
      name: "retains failure when only transient notices follow",
      result: {
        payloads: [
          { text: "private provider failure", isError: true },
          { text: "commentary", isCommentary: true },
          { text: "compaction", isCompactionNotice: true },
          { text: "fallback", isFallbackNotice: true },
          { text: "durable reasoning", isReasoning: true },
          { text: "reasoning", isReasoningSnapshot: true },
          { text: "status", isStatusNotice: true },
          { text: "hidden", visible: false },
          {
            text: "TTS supplement",
            mediaUrl: "https://example.invalid/tts.mp3",
            ttsSupplement: { spokenText: "TTS supplement" },
          },
        ],
      },
      reason: "failed",
    },
    {
      name: "retains failure when only whitespace follows",
      result: {
        payloads: [{ text: "private provider failure", isError: true }, { text: " \t\n " }],
      },
      reason: "failed",
    },
    {
      name: "keeps replay-invalid success",
      result: { meta: { replayInvalid: true } },
      reason: "completed",
    },
    {
      name: "classifies bare abort as cancellation",
      result: { meta: { aborted: true } },
      reason: "aborted",
    },
    {
      name: "preserves hard timeout attribution",
      result: { meta: { timeoutPhase: "provider" } },
      reason: "hard_timeout",
    },
  ])("$name", ({ result, reason }) => {
    expect(resolveOpenAiHttpAgentRunTerminalOutcome(result)).toMatchObject({ reason });
  });

  it("filters historical error text from recovered output", () => {
    expect(
      resolveOpenAiHttpResultText({
        payloads: [
          { text: "private provider failure", isError: true },
          { text: "fallback recovered" },
        ],
      }),
    ).toBe("fallback recovered");
  });
});
