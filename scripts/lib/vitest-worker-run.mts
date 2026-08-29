import type { ChildProcess } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fsSafeNativeCopy } from "./fs-safe-native-assets.mts";
import { createStateSchemaInlinePlugin } from "./state-schema-inline-plugin.mts";
import {
  hashVitestWorkerArtifact,
  verifyVitestWorkerArtifacts,
  vitestWorkerDeclarationEntries,
  VITEST_WORKER_PREPARE_REQUEST,
  VITEST_WORKER_PREPARE_REPLY,
  type VitestWorkerDescriptor,
  type VitestWorkerManifest,
} from "./vitest-worker-artifacts.mts";
import { vitestWorkerBuildEntries } from "./vitest-worker-build-entries.mts";

const root = fileURLToPath(new URL("../../", import.meta.url));
const require = createRequire(import.meta.url);

function createVitestWorkerDirectory() {
  const parent = path.join(root, ".artifacts", "vitest-workers");
  fs.mkdirSync(parent, { recursive: true });
  const directory = fs.mkdtempSync(path.join(parent, "run-"));
  fs.writeFileSync(path.join(directory, "package.json"), '{"type":"module"}\n');
  return directory;
}

export async function prepareVitestWorkerArtifacts(
  directory: string,
): Promise<VitestWorkerManifest> {
  const started = performance.now();
  // Node owns this public ESM load, even after Vite's config runner has closed.
  const { build }: typeof import("tsdown") = require("tsdown");
  const inputs: Record<string, string> = {};
  const outputs: Record<string, string> = {};
  const recordInput = (id: string) => {
    const normalized = id.replaceAll("\\", "/");
    if (!path.isAbsolute(normalized) || normalized.split("/").includes("node_modules")) {
      return;
    }
    if (normalized.split("/").includes("dist")) {
      throw new Error(`Compiled subprocess build tried to read dist: ${id}`);
    }
    const filename = path.normalize(normalized);
    if (fs.statSync(filename).isFile()) {
      inputs[filename] ??= hashVitestWorkerArtifact(fs.readFileSync(filename));
    }
  };
  for (const name of [
    "tsconfig.json",
    "package.json",
    "pnpm-lock.yaml",
    "scripts/lib/vitest-worker-artifacts.mts",
    "scripts/lib/vitest-worker-run.mts",
    "scripts/lib/runtime-process-build-entries.mts",
    "scripts/lib/vitest-worker-build-entries.mts",
    "scripts/lib/fs-safe-native-assets.mts",
    "scripts/lib/state-schema-inline-plugin.mts",
    "scripts/lib/vitest-cli-mode.mts",
  ]) {
    recordInput(path.join(root, name));
  }
  const entry = {
    ...vitestWorkerBuildEntries,
    ...vitestWorkerDeclarationEntries,
  };
  const schemaPlugin = createStateSchemaInlinePlugin(root);
  const outDir = path.join(directory, "dist");
  const nativeCopy = fsSafeNativeCopy({ outDir });
  // tsdown copies resources after generateBundle. Pin source bytes first so
  // verification cannot bless missing or altered copies with a post-build scan.
  for (const name of fs.readdirSync(nativeCopy.from, { recursive: true, encoding: "utf8" })) {
    const source = path.join(nativeCopy.from, name);
    if (fs.statSync(source).isFile()) {
      const target = path.join(nativeCopy.to, path.basename(nativeCopy.from), name);
      outputs[path.relative(outDir, target)] = hashVitestWorkerArtifact(fs.readFileSync(source));
    }
  }
  await build({
    config: false,
    cwd: root,
    entry,
    outDir,
    copy: nativeCopy,
    format: "esm",
    platform: "node",
    tsconfig: path.join(root, "tsconfig.json"),
    dts: false,
    envPrefix: [],
    clean: false,
    outExtensions: () => ({ js: ".js" }),
    deps: {
      neverBundle: true,
      alwaysBundle: (id) => id.startsWith("@openclaw/") || id.startsWith("openclaw/"),
    },
    logLevel: "warn",
    plugins: [
      {
        name: "openclaw:worker-build-inputs",
        load(id) {
          recordInput(id);
          return null;
        },
        generateBundle(_options, bundle) {
          for (const id of Object.keys(inputs)) {
            let packageDirectory = path.dirname(id);
            while (packageDirectory.startsWith(root)) {
              const manifest = path.join(packageDirectory, "package.json");
              if (fs.existsSync(manifest)) {
                recordInput(manifest);
                break;
              }
              packageDirectory = path.dirname(packageDirectory);
            }
          }
          for (const [name, output] of Object.entries(bundle)) {
            outputs[name] = hashVitestWorkerArtifact(
              output.type === "chunk" ? output.code : Buffer.from(output.source),
            );
          }
        },
      },
      {
        ...schemaPlugin,
        load(id) {
          return schemaPlugin.load.call(
            {
              addWatchFile: (file) => {
                recordInput(file);
                this.addWatchFile(file);
              },
            },
            id,
          );
        },
      },
    ],
  });
  for (const name of Object.keys(entry)) {
    fs.accessSync(path.join(directory, "dist", `${name}.js`));
  }
  const sortedInputs = Object.fromEntries(
    Object.entries(inputs).toSorted(([a], [b]) => a.localeCompare(b)),
  );
  const sortedOutputs = Object.fromEntries(
    Object.entries(outputs).toSorted(([a], [b]) => a.localeCompare(b)),
  );
  const manifest: VitestWorkerManifest = {
    identity: hashVitestWorkerArtifact(JSON.stringify([sortedInputs, sortedOutputs])),
    inputs: sortedInputs,
    outputs: sortedOutputs,
    durationMs: performance.now() - started,
  };
  verifyVitestWorkerArtifacts(directory, manifest);
  fs.writeFileSync(path.join(directory, "manifest.json"), `${JSON.stringify(manifest)}\n`);
  console.error(
    `[vitest-workers] prepared ${manifest.identity.slice(0, 12)} in ${Math.round(manifest.durationMs)}ms (${Object.keys(inputs).length} inputs, ${Object.keys(outputs).length} outputs)`,
  );
  return manifest;
}

/** The invocation owns preparation and waits for every real borrower before disposal. */
export function createVitestWorkerRun() {
  const directory = createVitestWorkerDirectory();
  let preparation: Promise<VitestWorkerManifest> | undefined;
  let disposal: Promise<void> | undefined;
  const borrowers: Promise<unknown>[] = [];
  let channelError: Error | undefined;
  return {
    descriptor: { directory } satisfies VitestWorkerDescriptor,
    borrow<T>(child: ChildProcess, completion: Promise<T>): Promise<T> {
      let requested = false;
      const onMessage = (message: unknown) => {
        if (message !== VITEST_WORKER_PREPARE_REQUEST || requested) {
          return;
        }
        requested = true;
        void (async () => {
          let reply: { type: string; error?: string } = { type: VITEST_WORKER_PREPARE_REPLY };
          try {
            if (disposal) {
              throw new Error("Compiled subprocess owner is closing");
            }
            await (preparation ??= prepareVitestWorkerArtifacts(directory));
            if (disposal) {
              throw new Error("Compiled subprocess owner is closing");
            }
          } catch (error) {
            reply = { type: VITEST_WORKER_PREPARE_REPLY, error: String(error) };
          }
          if (child.connected) {
            child.send(reply, (error) => {
              channelError ??= error ?? undefined;
            });
          }
        })();
      };
      child.on("message", onMessage);
      // Existing Windows completion observes exit; artifact ownership additionally
      // waits for close so inherited handles cannot outlive deletion.
      const closed = new Promise<void>((resolve) => {
        child.once("close", () => resolve());
      });
      const joined = Promise.all([completion, closed])
        .then(([result]) => result)
        .finally(() => {
          child.off("message", onMessage);
        });
      borrowers.push(joined);
      void joined.catch(() => {});
      return joined;
    },
    dispose(): Promise<void> {
      return (disposal ??= (async () => {
        const settled = await Promise.allSettled(borrowers);
        const uncertain = settled.find((result) => result.status === "rejected");
        try {
          await preparation;
          if (uncertain?.status === "rejected") {
            throw uncertain.reason;
          }
          if (channelError) {
            throw channelError;
          }
          if (fs.existsSync(path.join(directory, "manifest.json"))) {
            verifyVitestWorkerArtifacts(directory);
          }
        } finally {
          if (uncertain) {
            console.error(`[vitest-workers] retaining ${directory}: borrower join failed`);
          } else {
            fs.rmSync(directory, { recursive: true, force: true });
          }
        }
      })());
    },
  };
}

export type VitestWorkerRun = ReturnType<typeof createVitestWorkerRun>;
