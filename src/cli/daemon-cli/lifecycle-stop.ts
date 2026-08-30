// Gateway stop orchestration for system-scope services and unmanaged listeners.
import { resolveGatewayServiceProbeHosts } from "../../daemon/gateway-service-probe-hosts.js";
import { findInstalledSystemdGatewayScope, stopSystemdService } from "../../daemon/systemd.js";
import {
  findVerifiedGatewayListenerPidsOnPortSync,
  formatGatewayPidList,
  signalVerifiedGatewayPidSync,
} from "../../infra/gateway-processes.js";
import { probePortUsage } from "../../infra/ports-probe.js";
import { runWithGatewayStopIntent } from "../../infra/restart-intent.js";
import { formatCliCommand } from "../command-format.js";
import {
  appendGatewayLifecycleAudit,
  createGatewayLifecycleMutationAudit,
} from "./lifecycle-audit.js";
import { createNullWriter } from "./response.js";

function resolveVerifiedGatewayListenerPids(port: number): number[] {
  return findVerifiedGatewayListenerPidsOnPortSync(port).filter(
    (pid): pid is number => Number.isFinite(pid) && pid > 0,
  );
}

async function stopSystemScopeSystemdGateway(): Promise<{
  result: "stopped";
  message: string;
} | null> {
  if (process.platform !== "linux") {
    return null;
  }
  const installed = await findInstalledSystemdGatewayScope(process.env).catch(() => null);
  if (installed?.scope !== "system") {
    return null;
  }
  await stopSystemdService({
    stdout: createNullWriter(),
    env: process.env,
    onMutation: createGatewayLifecycleMutationAudit({ action: "stop" }),
  });
  return {
    result: "stopped",
    message: `Gateway stopped via system-scope systemd unit ${installed.unitName}.`,
  };
}

export async function stopGatewayWithoutServiceManager(
  port: number,
  lockOwnerPid: number | undefined,
  serviceContext?: Parameters<typeof resolveGatewayServiceProbeHosts>[0],
  force = false,
) {
  const listenerPids = resolveVerifiedGatewayListenerPids(port);
  // Listener discovery needs lsof, which minimal containers omit. The gateway
  // lock already names the verified owner of this port, so signal it instead of
  // reporting the gateway as not running while it keeps serving.
  const pids = listenerPids.length > 0 ? listenerPids : lockOwnerPid ? [lockOwnerPid] : [];
  // The single persisted lifecycle slot is PID-bound. If discovery is ambiguous,
  // preserve an ordinary stop instead of granting force to the wrong listener.
  return await runWithGatewayStopIntent(
    { force, targetPid: pids.length === 1 ? pids[0] : undefined },
    async () => {
      const managed = await stopSystemScopeSystemdGateway();
      if (managed) {
        return managed;
      }
      if (pids.length === 0) {
        const probeHosts = await resolveGatewayServiceProbeHosts(serviceContext ?? {});
        const portUsage = await probePortUsage(port, probeHosts);
        if (portUsage !== "free") {
          throw new Error(
            portUsage === "busy"
              ? `Port ${port} is in use but the owning process could not be identified. Run ${formatCliCommand("openclaw gateway status --deep")} to diagnose.`
              : `Could not determine whether port ${port} is still in use, so the gateway cannot be confirmed stopped. Run ${formatCliCommand("openclaw gateway status --deep")} to diagnose.`,
          );
        }
        return null;
      }
      for (const pid of pids) {
        signalVerifiedGatewayPidSync(pid, "SIGTERM");
        appendGatewayLifecycleAudit({
          action: "stop",
          source: "cli",
          mode: "sigterm",
          pid,
        });
      }
      return {
        result: "stopped" as const,
        message: `Gateway stop signal sent to unmanaged process${pids.length === 1 ? "" : "es"} on port ${port}: ${formatGatewayPidList(pids)}.`,
      };
    },
  );
}
