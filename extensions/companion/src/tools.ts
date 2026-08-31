import { jsonResult, type AnyAgentTool } from "openclaw/plugin-sdk/core";
import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { Type } from "typebox";
import {
  buildPortStatus,
  removePortRegistration,
  scanTcpListeners,
  upsertPortRegistration,
  type PortListener,
  type PortRegistrationStore,
} from "./ports.js";

const PROJECT_PATTERN = "^[^\\x00-\\x1F\\x7F]+$";

const PortsParamsSchema = Type.Object(
  {
    project: Type.Optional(Type.String({ minLength: 1, maxLength: 128, pattern: PROJECT_PATTERN })),
    includeUnregistered: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

const PortRegistryParamsSchema = Type.Object(
  {
    action: Type.Union([Type.Literal("register"), Type.Literal("remove")]),
    project: Type.String({ minLength: 1, maxLength: 128, pattern: PROJECT_PATTERN }),
    service: Type.String({ minLength: 1, maxLength: 128, pattern: PROJECT_PATTERN }),
    port: Type.Optional(Type.Integer({ minimum: 1, maximum: 65_535 })),
    note: Type.Optional(Type.String({ maxLength: 300, pattern: PROJECT_PATTERN })),
  },
  { additionalProperties: false },
);

function normalizeLabel(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`${label} must not be blank`);
  }
  return normalized;
}

async function scanWithError(): Promise<{ listeners: PortListener[]; scanError?: string }> {
  try {
    return { listeners: await scanTcpListeners() };
  } catch (error) {
    return {
      listeners: [],
      scanError: error instanceof Error ? error.message : String(error),
    };
  }
}

export function createCompanionPortTools(params: {
  registrations: PortRegistrationStore;
  scan?: () => Promise<{ listeners: PortListener[]; scanError?: string }>;
  now?: () => number;
}): AnyAgentTool[] {
  const scan = params.scan ?? scanWithError;
  const status = async (options: { project?: string; includeUnregistered?: boolean } = {}) => {
    const scanned = await scan();
    return await buildPortStatus({
      store: params.registrations,
      listeners: scanned.listeners,
      ...(options.project ? { project: options.project } : {}),
      includeUnregistered: options.includeUnregistered,
      scanError: scanned.scanError,
      now: params.now,
    });
  };

  return [
    {
      name: "companion_ports",
      label: "Companion Ports",
      description:
        "Read the owner's cross-project TCP port registry and compare declared ports with active local listeners. Use before starting a local service or when diagnosing a port collision. This never stops a process.",
      parameters: PortsParamsSchema,
      async execute(_toolCallId, rawParams) {
        const toolParams = asOptionalRecord(rawParams) ?? {};
        const project = typeof toolParams.project === "string" ? toolParams.project : undefined;
        return jsonResult(
          await status({
            ...(project ? { project: normalizeLabel(project, "project") } : {}),
            includeUnregistered: toolParams.includeUnregistered === true,
          }),
        );
      },
    },
    {
      name: "companion_port_registry",
      label: "Companion Port Registry",
      description:
        "Register, update, or remove an owner's declared local TCP port. Registration records intent only; it never starts, stops, or reconfigures a service.",
      parameters: PortRegistryParamsSchema,
      async execute(_toolCallId, rawParams) {
        const toolParams = asOptionalRecord(rawParams) ?? {};
        if (typeof toolParams.project !== "string" || typeof toolParams.service !== "string") {
          throw new Error("project and service are required");
        }
        const project = normalizeLabel(toolParams.project, "project");
        const service = normalizeLabel(toolParams.service, "service");
        if (toolParams.action === "remove") {
          const removed = await removePortRegistration({
            store: params.registrations,
            project,
            service,
          });
          return jsonResult({ action: "remove", project, service, removed });
        }
        if (toolParams.action !== "register") {
          throw new Error("action must be register or remove");
        }
        const port = toolParams.port;
        if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65_535) {
          throw new Error("port is required when action is register");
        }
        const note = typeof toolParams.note === "string" ? toolParams.note.trim() : undefined;
        const registration = await upsertPortRegistration({
          store: params.registrations,
          project,
          service,
          port,
          ...(note ? { note } : {}),
          now: params.now,
        });
        return jsonResult({
          action: "register",
          registration,
          status: await status({ project }),
        });
      },
    },
  ];
}
