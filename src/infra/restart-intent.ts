// Persists short-lived Gateway lifecycle intent for supervisor signal handoff.
import { asPositiveSafeInteger } from "@openclaw/normalization-core/number-coercion";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { createSubsystemLogger } from "../logging/subsystem.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "./kysely-sync.js";

const GATEWAY_RESTART_INTENT_KEY = "gateway-restart";
const GATEWAY_RESTART_INTENT_TTL_MS = 60_000;

const restartLog = createSubsystemLogger("restart");
type GatewayRestartIntentDatabase = Pick<OpenClawStateKyselyDatabase, "gateway_restart_intent">;

type GatewayRestartIntentPayload = {
  kind: "gateway-restart";
  pid: number;
  createdAt: number;
  reason?: string;
  force?: boolean;
  waitMs?: number;
};

type GatewayStopIntentPayload = {
  kind: "gateway-stop";
  pid: number;
  createdAt: number;
  force: true;
};

export type GatewayLifecycleIntent =
  | { kind: "restart"; intent: GatewayRestartIntent }
  | { kind: "stop"; force: true };

export type GatewayRestartIntent = {
  reason?: string;
  force?: boolean;
  waitMs?: number;
  // Process-local only: persisted restart requests cannot delegate successor ownership.
  successorOwner?: {
    kind: "managed-update-handoff";
    handoffId: string;
    installRoot: string;
  };
};

export function normalizeRestartIntentReason(reason: string | undefined): string | undefined {
  const normalized = reason?.trim();
  return normalized ? truncateUtf16Safe(normalized, 200) : undefined;
}

export function writeGatewayRestartIntentSync(opts: {
  env?: NodeJS.ProcessEnv;
  targetPid?: number;
  intent?: GatewayRestartIntent;
  reason?: string;
}): boolean {
  const waitMs =
    typeof opts.intent?.waitMs === "number" &&
    Number.isFinite(opts.intent.waitMs) &&
    opts.intent.waitMs >= 0
      ? Math.floor(opts.intent.waitMs)
      : null;
  return writeGatewayLifecycleIntentSync({
    env: opts.env,
    targetPid: opts.targetPid,
    kind: "gateway-restart",
    reason: normalizeRestartIntentReason(opts.reason ?? opts.intent?.reason) ?? null,
    force: opts.intent?.force ? 1 : null,
    waitMs,
  });
}

function writeGatewayStopIntentSync(opts: {
  env?: NodeJS.ProcessEnv;
  targetPid?: number;
}): boolean {
  return writeGatewayLifecycleIntentSync({
    env: opts.env,
    targetPid: opts.targetPid,
    kind: "gateway-stop",
    reason: null,
    force: 1,
    waitMs: null,
  });
}

export async function runWithGatewayStopIntent<T>(
  opts: { env?: NodeJS.ProcessEnv; force?: boolean; targetPid?: number },
  mutate: () => Promise<T>,
): Promise<T> {
  // Persist before the supervisor mutation; only a successful signal should leave
  // the PID-bound intent for the target process to consume during SIGTERM handling.
  const wroteStopIntent =
    Boolean(opts.force) && writeGatewayStopIntentSync({ env: opts.env, targetPid: opts.targetPid });
  try {
    return await mutate();
  } catch (err) {
    if (wroteStopIntent) {
      clearGatewayRestartIntentSync(opts.env);
    }
    throw err;
  }
}

function writeGatewayLifecycleIntentSync(opts: {
  env?: NodeJS.ProcessEnv;
  targetPid?: number;
  kind: "gateway-restart" | "gateway-stop";
  reason: string | null;
  force: number | null;
  waitMs: number | null;
}): boolean {
  const targetPid = asPositiveSafeInteger(opts.targetPid) ?? null;
  if (targetPid === null) {
    return false;
  }
  const env = opts.env ?? process.env;
  try {
    const createdAt = Date.now();
    runOpenClawStateWriteTransaction(
      ({ db }) => {
        const stateDb = getNodeSqliteKysely<GatewayRestartIntentDatabase>(db);
        executeSqliteQuerySync(
          db,
          stateDb
            .insertInto("gateway_restart_intent")
            .values({
              intent_key: GATEWAY_RESTART_INTENT_KEY,
              kind: opts.kind,
              pid: targetPid,
              created_at: createdAt,
              reason: opts.reason,
              force: opts.force,
              wait_ms: opts.waitMs,
              updated_at_ms: createdAt,
            })
            .onConflict((conflict) =>
              conflict.column("intent_key").doUpdateSet({
                kind: (eb) => eb.ref("excluded.kind"),
                pid: (eb) => eb.ref("excluded.pid"),
                created_at: (eb) => eb.ref("excluded.created_at"),
                reason: (eb) => eb.ref("excluded.reason"),
                force: (eb) => eb.ref("excluded.force"),
                wait_ms: (eb) => eb.ref("excluded.wait_ms"),
                updated_at_ms: (eb) => eb.ref("excluded.updated_at_ms"),
              }),
            ),
        );
      },
      { env },
    );
    return true;
  } catch (err) {
    restartLog.warn(
      `failed to write gateway ${opts.kind === "gateway-restart" ? "restart" : "stop"} intent: ${String(err)}`,
    );
    return false;
  }
}

export function clearGatewayRestartIntentSync(env: NodeJS.ProcessEnv = process.env): void {
  try {
    runOpenClawStateWriteTransaction(
      ({ db }) => {
        const stateDb = getNodeSqliteKysely<GatewayRestartIntentDatabase>(db);
        executeSqliteQuerySync(
          db,
          stateDb
            .deleteFrom("gateway_restart_intent")
            .where("intent_key", "=", GATEWAY_RESTART_INTENT_KEY),
        );
      },
      { env },
    );
  } catch {}
}

function readGatewayLifecycleIntentPayloadSync(
  env: NodeJS.ProcessEnv,
): GatewayRestartIntentPayload | GatewayStopIntentPayload | null {
  try {
    const { db } = openOpenClawStateDatabase({ env });
    const stateDb = getNodeSqliteKysely<GatewayRestartIntentDatabase>(db);
    const parsed = executeSqliteQueryTakeFirstSync(
      db,
      stateDb
        .selectFrom("gateway_restart_intent")
        .select(["kind", "pid", "created_at", "reason", "force", "wait_ms"])
        .where("intent_key", "=", GATEWAY_RESTART_INTENT_KEY),
    );
    if (
      parsed &&
      typeof parsed.pid === "number" &&
      Number.isFinite(parsed.pid) &&
      typeof parsed.created_at === "number" &&
      Number.isFinite(parsed.created_at) &&
      (parsed.reason === null || typeof parsed.reason === "string") &&
      (parsed.force === null ||
        (typeof parsed.force === "number" && Number.isFinite(parsed.force))) &&
      (parsed.wait_ms === null ||
        (typeof parsed.wait_ms === "number" &&
          Number.isFinite(parsed.wait_ms) &&
          parsed.wait_ms >= 0))
    ) {
      if (
        parsed.kind === "gateway-stop" &&
        parsed.force === 1 &&
        parsed.reason === null &&
        parsed.wait_ms === null
      ) {
        return {
          kind: "gateway-stop",
          pid: parsed.pid,
          createdAt: parsed.created_at,
          force: true,
        };
      }
      if (parsed.kind !== "gateway-restart") {
        return null;
      }
      const reason = normalizeRestartIntentReason(parsed.reason ?? undefined);
      return {
        kind: "gateway-restart",
        pid: parsed.pid,
        createdAt: parsed.created_at,
        ...(reason ? { reason } : {}),
        ...(parsed.force ? { force: true } : {}),
        ...(typeof parsed.wait_ms === "number" ? { waitMs: Math.floor(parsed.wait_ms) } : {}),
      };
    }
  } catch {
    return null;
  }
  return null;
}

export function consumeGatewayRestartIntentPayloadSync(
  env: NodeJS.ProcessEnv = process.env,
  now = Date.now(),
): GatewayRestartIntent | null {
  const lifecycleIntent = consumeGatewayLifecycleIntentSync(env, now);
  return lifecycleIntent?.kind === "restart" ? lifecycleIntent.intent : null;
}

export function consumeGatewayLifecycleIntentSync(
  env: NodeJS.ProcessEnv = process.env,
  now = Date.now(),
): GatewayLifecycleIntent | null {
  const payload = readGatewayLifecycleIntentPayloadSync(env);
  clearGatewayRestartIntentSync(env);
  if (!payload || payload.pid !== process.pid) {
    return null;
  }
  const ageMs = now - payload.createdAt;
  if (ageMs < 0 || ageMs > GATEWAY_RESTART_INTENT_TTL_MS) {
    return null;
  }
  if (payload.kind === "gateway-stop") {
    return { kind: "stop", force: true };
  }
  return {
    kind: "restart",
    intent: {
      ...(payload.reason ? { reason: payload.reason } : {}),
      ...(payload.force ? { force: true } : {}),
      ...(typeof payload.waitMs === "number" ? { waitMs: payload.waitMs } : {}),
    },
  };
}

export function consumeGatewayRestartIntentSync(
  env: NodeJS.ProcessEnv = process.env,
  now = Date.now(),
): boolean {
  return consumeGatewayRestartIntentPayloadSync(env, now) !== null;
}
