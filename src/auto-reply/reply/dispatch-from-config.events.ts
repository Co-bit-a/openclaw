import type { PluginHookReplyDispatchEvent } from "../../plugins/hook-types.js";
import type { CommandSessionMetadataChange } from "./command-session-metadata.js";
import type { InternalGetReplyOptions, ReplySessionBinding } from "./get-reply.types.js";

export type InternalReplyResolverOptions = {
  onDeliberateSilentTerminalReply?: () => void;
  onPendingContinuation?: () => void;
  onSessionMetadataChanges?: (changes: CommandSessionMetadataChange[]) => void;
  onSessionPrepared?: (binding: ReplySessionBinding) => void;
};

export type PluginBindingTranscriptOwner = {
  agentId: string;
  expectedSessionId?: string;
  sessionKey: string;
  transcriptWriteBlocked?: true;
};

export function createReplyDispatchEvent(
  params: Omit<
    PluginHookReplyDispatchEvent,
    "admittedSessionSettingsRestricted" | "shouldSendToolSummaries"
  > & {
    admittedSessionSettings?: InternalGetReplyOptions["admittedSessionSettings"];
    shouldSendToolSummaries: () => boolean;
  },
): PluginHookReplyDispatchEvent {
  const { admittedSessionSettings, shouldSendToolSummaries, ...event } = params;
  const admittedSessionSettingsRestricted =
    (admittedSessionSettings?.permissionMode !== undefined &&
      admittedSessionSettings.permissionMode !== "full") ||
    (admittedSessionSettings?.toolOverrides !== undefined &&
      Object.keys(admittedSessionSettings.toolOverrides).length > 0);
  return Object.defineProperties(event, {
    // Hook handlers share this event. Expose only an immutable derived fact so
    // one handler cannot rewrite admitted authority before ACP consumes it.
    admittedSessionSettingsRestricted: {
      enumerable: true,
      value: admittedSessionSettingsRestricted,
      writable: false,
    },
    shouldSendToolSummaries: {
      enumerable: true,
      get: shouldSendToolSummaries,
    },
  }) as PluginHookReplyDispatchEvent;
}
