import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { isPathInside } from "openclaw/plugin-sdk/file-access-runtime";

const PROJECT_MARKERS = new Set([
  ".git",
  "Cargo.toml",
  "build.gradle",
  "build.gradle.kts",
  "composer.json",
  "go.mod",
  "package.json",
  "pom.xml",
  "pyproject.toml",
]);
const FINGERPRINT_MANIFESTS = new Set([...PROJECT_MARKERS].filter((marker) => marker !== ".git"));
const EXCLUDED_DIRECTORIES = new Set([
  ".cache",
  ".git",
  ".next",
  ".pytest_cache",
  ".tox",
  ".venv",
  "__pycache__",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "target",
  "vendor",
  "venv",
]);
const SOURCE_ROOTS = new Set(["app", "lib", "packages", "src"]);
const SOURCE_EXTENSIONS = new Set([
  ".c",
  ".cc",
  ".cpp",
  ".go",
  ".h",
  ".hpp",
  ".java",
  ".js",
  ".jsx",
  ".kt",
  ".mjs",
  ".mts",
  ".py",
  ".rs",
  ".svelte",
  ".swift",
  ".ts",
  ".tsx",
  ".vue",
]);
const DISPOSABLE_NAME_PATTERN =
  /(?:^|[-_. ])(?:bak|backup|copy|demo|example|old|sample|temp|test|testing|tmp)(?:[-_. ]|$)/iu;
const MAX_DISCOVERY_DIRECTORIES = 10_000;
const MAX_PROJECT_FILES = 1_000;
const MAX_FINGERPRINT_FILES = 256;
const MAX_FINGERPRINT_FILE_BYTES = 512 * 1024;
const MAX_FINGERPRINT_TOTAL_BYTES = 16 * 1024 * 1024;

export type ProjectAuditOptions = {
  workspaceDir: string;
  roots?: string[];
  maxDepth?: number;
  maxProjects?: number;
  staleDays?: number;
  now?: () => number;
};

type InspectedProject = {
  absolutePath: string;
  relativePath: string;
  markers: string[];
  lastActivityAtMs: number;
  ageDays: number;
  fingerprint?: string;
  fingerprintComplete: boolean;
};

type ReviewPriority = "high" | "medium" | "low";

export type ProjectAuditResult = {
  advisory: true;
  workspace: ".";
  scannedRoots: string[];
  summary: {
    directoriesVisited: number;
    projectsFound: number;
    reviewCandidates: number;
    duplicateGroups: number;
    truncated: boolean;
  };
  duplicateGroups: Array<{
    id: string;
    confidence: "exact-bounded-content";
    paths: string[];
  }>;
  reviewCandidates: Array<{
    path: string;
    markers: string[];
    ageDays: number;
    lastActivityAtMs: number;
    priority: ReviewPriority;
    signals: string[];
  }>;
  note: string;
};

function displayRelativePath(workspaceDir: string, absolutePath: string): string {
  const relative = path.relative(workspaceDir, absolutePath);
  return relative ? relative.split(path.sep).join(path.posix.sep) : ".";
}

async function resolveRoots(workspaceDir: string, roots: string[]): Promise<string[]> {
  const canonicalWorkspace = await realpath(workspaceDir);
  const resolved: string[] = [];
  for (const root of roots) {
    if (!root.trim() || path.isAbsolute(root)) {
      throw new Error("project audit roots must be non-empty workspace-relative paths");
    }
    const candidate = await realpath(path.resolve(canonicalWorkspace, root));
    if (candidate !== canonicalWorkspace && !isPathInside(canonicalWorkspace, candidate)) {
      throw new Error(`project audit root escapes the workspace: ${root}`);
    }
    const candidateStat = await stat(candidate);
    if (!candidateStat.isDirectory()) {
      throw new Error(`project audit root is not a directory: ${root}`);
    }
    resolved.push(candidate);
  }
  return [...new Set(resolved)];
}

async function discoverProjects(params: {
  roots: string[];
  maxDepth: number;
  maxProjects: number;
}): Promise<{
  projects: Array<{ absolutePath: string; markers: string[] }>;
  visited: number;
  truncated: boolean;
}> {
  const projects: Array<{ absolutePath: string; markers: string[] }> = [];
  const queue = params.roots.map((absolutePath) => ({ absolutePath, depth: 0 }));
  let visited = 0;
  let truncated = false;

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) {
      break;
    }
    if (visited >= MAX_DISCOVERY_DIRECTORIES || projects.length >= params.maxProjects) {
      truncated = true;
      break;
    }
    visited += 1;
    let entries;
    try {
      entries = await readdir(current.absolutePath, { withFileTypes: true });
    } catch {
      continue;
    }
    const names = new Set(entries.map((entry) => entry.name));
    const markers = [...PROJECT_MARKERS].filter((marker) => names.has(marker)).toSorted();
    if (markers.length > 0) {
      projects.push({ absolutePath: current.absolutePath, markers });
    }
    if (current.depth >= params.maxDepth) {
      continue;
    }
    for (const entry of entries.toSorted((left, right) => left.name.localeCompare(right.name))) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || EXCLUDED_DIRECTORIES.has(entry.name)) {
        continue;
      }
      queue.push({
        absolutePath: path.join(current.absolutePath, entry.name),
        depth: current.depth + 1,
      });
    }
  }
  return { projects, visited, truncated };
}

function isFingerprintCandidate(relativePath: string): boolean {
  const normalized = relativePath.split(path.sep).join(path.posix.sep);
  const segments = normalized.split("/");
  if (segments.length === 1 && FINGERPRINT_MANIFESTS.has(segments[0] ?? "")) {
    return true;
  }
  return SOURCE_ROOTS.has(segments[0] ?? "") && SOURCE_EXTENSIONS.has(path.extname(normalized));
}

function priorityRank(priority: ReviewPriority): number {
  if (priority === "high") {
    return 0;
  }
  if (priority === "medium") {
    return 1;
  }
  return 2;
}

async function inspectProject(params: {
  project: { absolutePath: string; markers: string[] };
  workspaceDir: string;
  nowMs: number;
}): Promise<InspectedProject> {
  const queue = [params.project.absolutePath];
  const fingerprints: Array<{ path: string; digest: string; size: number }> = [];
  let visitedFiles = 0;
  let fingerprintBytes = 0;
  let fingerprintComplete = true;
  let lastActivityAtMs = (await stat(params.project.absolutePath)).mtimeMs;

  while (queue.length > 0) {
    const directory = queue.shift();
    if (!directory) {
      break;
    }
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries.toSorted((left, right) => left.name.localeCompare(right.name))) {
      if (entry.isSymbolicLink()) {
        continue;
      }
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!EXCLUDED_DIRECTORIES.has(entry.name)) {
          queue.push(absolutePath);
        }
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      visitedFiles += 1;
      if (visitedFiles > MAX_PROJECT_FILES) {
        fingerprintComplete = false;
        queue.length = 0;
        break;
      }
      let fileStat;
      try {
        fileStat = await lstat(absolutePath);
      } catch {
        continue;
      }
      lastActivityAtMs = Math.max(lastActivityAtMs, fileStat.mtimeMs);
      const relativePath = path.relative(params.project.absolutePath, absolutePath);
      if (!isFingerprintCandidate(relativePath)) {
        continue;
      }
      if (
        fingerprints.length >= MAX_FINGERPRINT_FILES ||
        fileStat.size > MAX_FINGERPRINT_FILE_BYTES ||
        fingerprintBytes + fileStat.size > MAX_FINGERPRINT_TOTAL_BYTES
      ) {
        fingerprintComplete = false;
        continue;
      }
      try {
        const bytes = await readFile(absolutePath);
        fingerprintBytes += bytes.byteLength;
        fingerprints.push({
          path: relativePath.split(path.sep).join(path.posix.sep),
          digest: createHash("sha256").update(bytes).digest("hex"),
          size: bytes.byteLength,
        });
      } catch {
        fingerprintComplete = false;
      }
    }
  }

  const fingerprint =
    fingerprintComplete && fingerprints.length > 0
      ? createHash("sha256").update(JSON.stringify(fingerprints)).digest("hex")
      : undefined;
  return {
    absolutePath: params.project.absolutePath,
    relativePath: displayRelativePath(params.workspaceDir, params.project.absolutePath),
    markers: params.project.markers,
    lastActivityAtMs,
    ageDays: Math.max(0, Math.floor((params.nowMs - lastActivityAtMs) / 86_400_000)),
    fingerprint,
    fingerprintComplete,
  };
}

export async function auditWorkspaceProjects(
  options: ProjectAuditOptions,
): Promise<ProjectAuditResult> {
  const maxDepth = Math.max(1, Math.min(options.maxDepth ?? 3, 5));
  const maxProjects = Math.max(1, Math.min(options.maxProjects ?? 100, 200));
  const staleDays = Math.max(1, Math.min(options.staleDays ?? 120, 3_650));
  const canonicalWorkspace = await realpath(options.workspaceDir);
  const roots = await resolveRoots(canonicalWorkspace, options.roots ?? ["."]);
  const discovered = await discoverProjects({ roots, maxDepth, maxProjects });
  const nowMs = (options.now ?? Date.now)();
  const projects: InspectedProject[] = [];
  for (const project of discovered.projects) {
    projects.push(await inspectProject({ project, workspaceDir: canonicalWorkspace, nowMs }));
  }

  const fingerprintGroups = new Map<string, InspectedProject[]>();
  for (const project of projects) {
    if (!project.fingerprint || !project.fingerprintComplete) {
      continue;
    }
    const group = fingerprintGroups.get(project.fingerprint) ?? [];
    group.push(project);
    fingerprintGroups.set(project.fingerprint, group);
  }
  const duplicateGroups = [...fingerprintGroups.entries()]
    .filter(([, group]) => group.length > 1)
    .map(([fingerprint, group]) => ({
      id: `sha256:${fingerprint.slice(0, 16)}`,
      confidence: "exact-bounded-content" as const,
      paths: group.map((project) => project.relativePath).toSorted(),
    }))
    .toSorted((left, right) => left.id.localeCompare(right.id));
  const duplicatePaths = new Set(duplicateGroups.flatMap((group) => group.paths));

  const reviewCandidates = projects
    .map((project) => {
      const signals: string[] = [];
      if (project.ageDays >= staleDays) {
        signals.push(`no included project-file activity for ${project.ageDays} days`);
      }
      if (DISPOSABLE_NAME_PATTERN.test(path.basename(project.absolutePath))) {
        signals.push("directory name resembles a demo, test, copy, backup, or temporary project");
      }
      if (duplicatePaths.has(project.relativePath)) {
        signals.push("exact bounded-content fingerprint matches another discovered project");
      }
      const score =
        (project.ageDays >= staleDays ? 1 : 0) +
        (DISPOSABLE_NAME_PATTERN.test(path.basename(project.absolutePath)) ? 1 : 0) +
        (duplicatePaths.has(project.relativePath) ? 2 : 0);
      const priority: ReviewPriority = score >= 3 ? "high" : score >= 2 ? "medium" : "low";
      return {
        path: project.relativePath,
        markers: project.markers,
        ageDays: project.ageDays,
        lastActivityAtMs: project.lastActivityAtMs,
        priority,
        signals,
      };
    })
    .filter((candidate) => candidate.signals.length > 0)
    .toSorted(
      (left, right) =>
        priorityRank(left.priority) - priorityRank(right.priority) ||
        left.path.localeCompare(right.path),
    );

  return {
    advisory: true,
    workspace: ".",
    scannedRoots: roots.map((root) => displayRelativePath(canonicalWorkspace, root)),
    summary: {
      directoriesVisited: discovered.visited,
      projectsFound: projects.length,
      reviewCandidates: reviewCandidates.length,
      duplicateGroups: duplicateGroups.length,
      truncated: discovered.truncated || projects.some((project) => !project.fingerprintComplete),
    },
    duplicateGroups,
    reviewCandidates,
    note: "Heuristic, read-only audit. A candidate is not proof that a project is abandoned; review it before any move or deletion.",
  };
}
