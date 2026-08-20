import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  planPluginNpmSecurityArtifactDownloads,
  type PluginNpmSecurityArtifactDownloadPlan,
} from "./lib/plugin-npm-security-scan.mts";
import { readBoundedRegularFile } from "./plugin-publication-artifact.mjs";

const MAX_ARTIFACT_METADATA_JSON_BYTES = 4 * 1024 * 1024;
const MAX_EXPECTED_PACKAGES_JSON_BYTES = 256 * 1024;

type ParsedArgs = {
  artifactMetadataPath: string;
  candidateSha: string;
  expectedPackages: unknown;
  outputPath: string;
};

function parseArgs(argv: string[]): ParsedArgs {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name?.startsWith("--") || value === undefined || values.has(name)) {
      throw new Error(`Invalid plugin security artifact plan argument near ${name}.`);
    }
    values.set(name, value);
  }
  const artifactMetadataPath = values.get("--artifact-metadata-json") ?? "";
  const candidateSha = values.get("--candidate-sha") ?? "";
  const expectedPackagesJson = values.get("--expected-packages-json") ?? "";
  const outputPath = values.get("--output") ?? "";
  if (
    !artifactMetadataPath ||
    !/^[0-9a-f]{40}$/u.test(candidateSha) ||
    !expectedPackagesJson ||
    Buffer.byteLength(expectedPackagesJson, "utf8") > MAX_EXPECTED_PACKAGES_JSON_BYTES ||
    !outputPath
  ) {
    throw new Error("Plugin security artifact plan received an invalid identity or path.");
  }
  return {
    artifactMetadataPath: resolve(artifactMetadataPath),
    candidateSha,
    expectedPackages: JSON.parse(expectedPackagesJson) as unknown,
    outputPath: resolve(outputPath),
  };
}

function writePlan(outputPath: string, plan: PluginNpmSecurityArtifactDownloadPlan): void {
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(plan)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

function main(argv = process.argv.slice(2)): number {
  const args = parseArgs(argv);
  const artifactPages = JSON.parse(
    readBoundedRegularFile(args.artifactMetadataPath, {
      label: "Plugin security artifact API metadata",
      maxBytes: MAX_ARTIFACT_METADATA_JSON_BYTES,
    }).toString("utf8"),
  ) as unknown;
  const plan = planPluginNpmSecurityArtifactDownloads({
    artifactPages,
    candidateSha: args.candidateSha,
    expectedPackages: args.expectedPackages,
  });
  writePlan(args.outputPath, plan);
  console.log(
    `Plugin security artifact download plan: ${plan.artifacts.length}/${plan.expectedArtifactCount} accepted, ${plan.rejectedPackageNames.length} rejected, ${plan.totalBytes} bytes.`,
  );
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error("[plugin-npm-security-artifact-plan] FAILED (exit 1)");
    process.exitCode = 1;
  }
}
