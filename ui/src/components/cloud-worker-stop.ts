import { isCloudWorkerPlacementState } from "../../../packages/gateway-protocol/src/schema/session-placement-state.js";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import type { GatewaySessionRow } from "../api/types.ts";
import type { ApplicationPlacementStartup } from "../app/session-placement-startup.ts";
import { t } from "../i18n/index.ts";

export type CloudWorkerStopAction = {
  method: "sessions.reclaim";
  requiredScope: "operator.write";
  blocksActiveRun: boolean;
};

export function resolveCloudWorkerStopAction(
  placement: GatewaySessionRow["placement"],
): CloudWorkerStopAction | null {
  if (!placement || !isCloudWorkerPlacementState(placement.state)) {
    return null;
  }
  return {
    method: "sessions.reclaim",
    requiredScope: "operator.write",
    blocksActiveRun: placement.state === "active",
  };
}

export async function requestCloudWorkerStop(
  client: Pick<GatewayBrowserClient, "request">,
  session: { key: string; agentId?: string },
  startup: Pick<ApplicationPlacementStartup, "pause">,
): Promise<void> {
  startup.pause(session.key, t("sessionsView.initialTurnPausedByWorkerStop"));
  await client.request(
    "sessions.reclaim",
    { key: session.key, ...(session.agentId ? { agentId: session.agentId } : {}) },
    { timeoutMs: 10 * 60_000 },
  );
}
