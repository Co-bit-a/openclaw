/** Ordered cleanup for one prepared embedded run, after all retry attempts settle. */
import { formatErrorMessage } from "../../../infra/errors.js";
import {
  retireSessionMcpRuntime,
  retireSessionMcpRuntimeForSessionKey,
} from "../../agent-bundle-mcp-tools.js";
import type { ContextEngineLogicalTurnLease } from "../../harness/context-engine-logical-turn.js";
import { runAgentCleanupStep } from "../../run-cleanup-timeout.js";
import { log } from "../logger.js";
import { clearProviderPromptState } from "../provider-prompt-state.js";
import { forgetPromptBuildDrainCacheForRun } from "./attempt-prompt-helpers.js";
import type { PreparedEmbeddedRunInput } from "./execution-context.js";

export async function cleanupEmbeddedRunRuntime(input: {
  runParams: Pick<
    PreparedEmbeddedRunInput["runParams"],
    "runId" | "sessionId" | "sessionKey" | "isFinalFallbackAttempt" | "cleanupBundleMcpOnRunEnd"
  >;
  closePermissionChanges: () => void;
  maybeEmitFastModeAutoResetBestEffort: () => Promise<void>;
  stopRuntimeAuthRefreshTimer: () => void;
  ownsContextEngineLogicalTurnLease: boolean;
  contextEngineLogicalTurnLease: ContextEngineLogicalTurnLease;
}): Promise<void> {
  const params = input.runParams;
  input.closePermissionChanges();
  if (params.isFinalFallbackAttempt !== false) {
    await input.maybeEmitFastModeAutoResetBestEffort();
  }
  forgetPromptBuildDrainCacheForRun(params.runId);
  clearProviderPromptState(params.runId);
  input.stopRuntimeAuthRefreshTimer();
  if (input.ownsContextEngineLogicalTurnLease) {
    await runAgentCleanupStep({
      runId: params.runId,
      sessionId: params.sessionId,
      step: "context-engine-dispose",
      log,
      cleanup: async () => {
        await input.contextEngineLogicalTurnLease.dispose();
      },
    });
  }
  if (params.cleanupBundleMcpOnRunEnd === true) {
    await runAgentCleanupStep({
      runId: params.runId,
      sessionId: params.sessionId,
      step: "bundle-mcp-retire",
      log,
      cleanup: async () => {
        const onError = (errorLocal: unknown, sessionId: string) => {
          log.warn(
            `bundle-mcp cleanup failed after run for ${sessionId}: ${formatErrorMessage(errorLocal)}`,
          );
        };
        const retiredBySessionKey = await retireSessionMcpRuntimeForSessionKey({
          sessionKey: params.sessionKey,
          reason: "embedded-run-end",
          // MCP App views hold bounded leases so their bridge can remain
          // usable after a one-shot gateway run returns.
          preserveActiveLeases: true,
          onError,
        });
        if (!retiredBySessionKey) {
          await retireSessionMcpRuntime({
            sessionId: params.sessionId,
            reason: "embedded-run-end",
            preserveActiveLeases: true,
            onError,
          });
        }
      },
    });
  }
}
