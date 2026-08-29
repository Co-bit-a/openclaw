// Native read boundary for synchronous test selectors; no tsx or application imports.
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import pMap from "p-map";
import { z } from "zod";

const IMPORT_SPECIFIER_PATTERN =
  /\b(?:import|export)\s+(?:type\s+)?(?:[^'"]*?\s+from\s+)?["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)/gu;
const REEXPORT_SPECIFIER_PATTERN =
  /\bexport\s+(?:type\s+)?(?:\*\s+(?:as\s+\w+\s+)?from\s+|[^"']+?\s+from\s+)["']([^"']+)["']/gu;
const requestSchema = z.object({
  files: z.array(z.object({ file: z.string(), parseImports: z.boolean() })),
  terms: z.array(z.string()),
});
const factsSchema = z.object({
  imports: z.array(z.string()),
  reexports: z.array(z.string()),
  matches: z.array(z.string()),
  references: z.array(z.string()),
});

/** Acquires complete JS-parsed facts with bounded asynchronous reads, joining one native child. */
export function readTestSelectorSourceFacts(
  cwd: string,
  files: z.infer<typeof requestSchema>["files"],
  terms: string[],
  maxBuffer: number,
) {
  if (files.length === 0) {
    return [];
  }
  // The selector API is synchronous. A finite child owns the async reads and
  // exits before we return; inheriting loader hooks would reintroduce tsx work.
  const env = { ...process.env };
  delete env.NODE_OPTIONS;
  const result = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
    cwd,
    env,
    input: JSON.stringify({ files, terms }),
    encoding: "utf8",
    maxBuffer,
    stdio: ["pipe", "pipe", "pipe"],
  });
  if (result.error || result.status !== 0 || result.signal) {
    throw new Error(
      `Test selector source scan failed (${result.signal ?? result.status}): ${result.stderr}`,
      { cause: result.error },
    );
  }
  // Position is the file identity: require every requested row, including unreadable files.
  return z
    .array(factsSchema.nullable())
    .length(files.length)
    .parse(JSON.parse(result.stdout))
    .flatMap((facts, index) => (facts ? [{ file: files[index]!.file, ...facts }] : []));
}

async function readSourceFacts() {
  let input = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) {
    input += chunk;
  }
  const { files, terms } = requestSchema.parse(JSON.parse(input));
  const facts = await pMap(
    files,
    async ({ file, parseImports }) => {
      let source: string;
      try {
        source = await readFile(file, "utf8");
      } catch {
        // Git inventories include deleted files; preserve the selector's unreadable-file behavior.
        return null;
      }
      const specifiers = (pattern: RegExp) =>
        parseImports
          ? [
              ...new Set(
                [...source.matchAll(pattern)]
                  .map((match) => match[1] ?? match[2] ?? "")
                  .filter((specifier) => specifier.startsWith(".")),
              ),
            ]
          : [];
      const matches = terms.filter((term) => source.includes(term));
      const tokens = matches.length > 0 ? new Set(source.match(/[A-Za-z0-9_.@+/-]{4,}/gu)) : null;
      return {
        imports: specifiers(IMPORT_SPECIFIER_PATTERN),
        reexports: specifiers(REEXPORT_SPECIFIER_PATTERN),
        matches,
        references: matches.filter((term) => tokens?.has(term)),
      };
    },
    { concurrency: 32, stopOnError: false },
  );
  // p-map joins every admitted read, including failures, before publishing any result.
  process.stdout.write(JSON.stringify(facts));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    await readSourceFacts();
  } catch (error) {
    console.error(error);
    console.error("[test-selector-source-facts] FAILED (exit 1)");
    process.exitCode = 1;
  }
}
