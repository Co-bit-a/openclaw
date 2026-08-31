import { jsonResult, type AnyAgentTool } from "openclaw/plugin-sdk/core";
import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { Type } from "typebox";
import { auditWorkspaceProjects } from "./project-audit.js";

const ProjectAuditParamsSchema = Type.Object(
  {
    roots: Type.Optional(
      Type.Array(Type.String({ minLength: 1, maxLength: 256 }), { minItems: 1, maxItems: 8 }),
    ),
    maxDepth: Type.Optional(Type.Integer({ minimum: 1, maximum: 5 })),
    maxProjects: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
    staleDays: Type.Optional(Type.Integer({ minimum: 1, maximum: 3_650 })),
  },
  { additionalProperties: false },
);

function readOptionalInteger(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isInteger(value) ? value : undefined;
}

export function createCompanionProjectAuditTool(workspaceDir: string): AnyAgentTool {
  return {
    name: "companion_project_audit",
    label: "Companion Project Audit",
    description:
      "Read-only audit of project directories inside the current workspace. Finds matching bounded-content fingerprints and flags stale projects or project names resembling demos, tests, copies, backups, or temporary work. Results are advisory and this tool never moves or deletes files.",
    parameters: ProjectAuditParamsSchema,
    async execute(_toolCallId, rawParams) {
      const params = asOptionalRecord(rawParams) ?? {};
      const roots = Array.isArray(params.roots)
        ? params.roots.filter((value): value is string => typeof value === "string")
        : undefined;
      return jsonResult(
        await auditWorkspaceProjects({
          workspaceDir,
          ...(roots ? { roots } : {}),
          maxDepth: readOptionalInteger(params, "maxDepth"),
          maxProjects: readOptionalInteger(params, "maxProjects"),
          staleDays: readOptionalInteger(params, "staleDays"),
        }),
      );
    },
  };
}
