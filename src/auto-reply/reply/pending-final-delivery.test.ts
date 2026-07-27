// Tests pending final delivery records and deferred message-tool send behavior.
import { describe, expect, it } from "vitest";
import {
  INTERNAL_RUNTIME_CONTEXT_BEGIN,
  INTERNAL_RUNTIME_CONTEXT_END,
} from "../../agents/internal-runtime-context.js";
import { sanitizePendingFinalDeliveryText } from "./pending-final-delivery.js";

describe("sanitizePendingFinalDeliveryText", () => {
  it("strips internal metadata from durable pending delivery text", () => {
    const text = [
      "Visible reply",
      INTERNAL_RUNTIME_CONTEXT_BEGIN,
      "internal detail",
      INTERNAL_RUNTIME_CONTEXT_END,
      "",
      "Conversation info (untrusted metadata):",
      "```json",
      '{"message_id":"msg-1"}',
      "```",
    ].join("\n");

    expect(sanitizePendingFinalDeliveryText(text)).toBe("Visible reply");
  });

  it("drops silent reply sentinel payloads", () => {
    expect(sanitizePendingFinalDeliveryText(" NO_REPLY ")).toBe("");
    expect(sanitizePendingFinalDeliveryText('"NO_REPLY"')).toBe("");
    expect(sanitizePendingFinalDeliveryText('{"action":"NO_REPLY"}')).toBe("");
  });

  it("strips mixed silent reply sentinels like normal delivery", () => {
    expect(sanitizePendingFinalDeliveryText("NO_REPLYThe user is saying hello")).toBe(
      "The user is saying hello",
    );
    expect(sanitizePendingFinalDeliveryText("HEARTBEAT_OK NO_REPLY")).toBe("HEARTBEAT_OK");
  });

  it.each([
    ["NO_REPLY\n\nThe user is saying hello", "The user is saying hello"],
    ["NO_REPLY\r\nThe user is saying hello", "The user is saying hello"],
    ["NO_REPLY NO_REPLY\nThe user is saying hello", "The user is saying hello"],
    ["NO_REPLY\n✅ Done", "✅ Done"],
    ["NO_REPLY\n- Done", "- Done"],
    ["NO_REPLY\n—note", "—note"],
    ["NO_REPLY\n: explanation", ": explanation"],
    ["NO_REPLY\n**Done**", "**Done**"],
    ['NO_REPLY\n"Hello"', '"Hello"'],
    ["NO_REPLY\n```ts\nconst done = true;\n```", "```ts\nconst done = true;\n```"],
  ])("strips newline-separated leading silent tokens from recovery text: %j", (text, expected) => {
    expect(sanitizePendingFinalDeliveryText(text)).toBe(expected);
  });

  it.each([
    "Done as requested!NO_REPLY",
    "question?NO_REPLY",
    "note,NO_REPLY",
    "item;NO_REPLY",
    "label:NO_REPLY",
  ])("preserves punctuation-attached silent-token literals in recovery: %j", (text) => {
    expect(sanitizePendingFinalDeliveryText(text)).toBe(text);
  });

  it("strips repeated trailing silent tokens from recovery text", () => {
    expect(sanitizePendingFinalDeliveryText("Done. NO_REPLY NO_REPLY")).toBe("Done.");
  });

  it.each([
    "interject.NO_REPLY",
    "The example is interject.NO_REPLY",
    "Done as requested.NO_REPLY",
    "NO_REPLY NO_REPLY: explanation",
    "NO_REPLY\nNO_REPLY: explanation",
    "NO_REPLY\nNO_REPLY—note",
    "NO_REPLY\nNO_REPLY-note",
    "NO_REPLY\nNO_REPLY -- nope",
  ])("preserves substantive dotted and punctuation-start recovery literals: %j", (text) => {
    expect(sanitizePendingFinalDeliveryText(text)).toBe(text);
  });

  it("preserves heartbeat ack text for ack-aware classification", () => {
    expect(sanitizePendingFinalDeliveryText("HEARTBEAT_OK short")).toBe("HEARTBEAT_OK short");
  });
});
