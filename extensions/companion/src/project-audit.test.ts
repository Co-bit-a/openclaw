import { mkdir, readFile, symlink, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it } from "vitest";
import { auditWorkspaceProjects } from "./project-audit.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

async function createFixture(): Promise<string> {
  return tempDirs.make("companion-audit-");
}

async function createProject(root: string, relativePath: string): Promise<string> {
  const project = path.join(root, relativePath);
  await mkdir(path.join(project, "src"), { recursive: true });
  await writeFile(path.join(project, "package.json"), '{"name":"fixture","version":"1.0.0"}\n');
  await writeFile(path.join(project, "src", "index.ts"), "export const value = 1;\n");
  return project;
}

describe("project audit", () => {
  it("finds matching bounded fingerprints and combines duplicate, name, and stale evidence", async () => {
    const root = await createFixture();
    const current = await createProject(root, "current-project");
    const oldDemo = await createProject(root, "demo-copy");
    await mkdir(path.join(current, "tests", "unit"), { recursive: true });
    await writeFile(path.join(current, "tests", "unit", "helper.ts"), "test helper\n");
    const old = new Date("2020-01-01T00:00:00Z");
    await Promise.all(
      [
        oldDemo,
        path.join(oldDemo, "package.json"),
        path.join(oldDemo, "src"),
        path.join(oldDemo, "src", "index.ts"),
      ].map((target) => utimes(target, old, old)),
    );

    const result = await auditWorkspaceProjects({
      workspaceDir: root,
      maxDepth: 3,
      staleDays: 30,
      now: () => Date.parse("2026-01-01T00:00:00Z"),
    });

    expect(result.summary).toMatchObject({
      projectsFound: 2,
      duplicateGroups: 1,
      reviewCandidates: 2,
    });
    expect(result.duplicateGroups[0]?.paths).toEqual(["current-project", "demo-copy"]);
    expect(result.reviewCandidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "demo-copy",
          priority: "high",
          signals: expect.arrayContaining([
            expect.stringContaining("activity"),
            expect.stringContaining("directory name"),
            expect.stringContaining("exact bounded-content fingerprint"),
          ]),
        }),
      ]),
    );
    expect(result.reviewCandidates.some((candidate) => candidate.path.includes("tests"))).toBe(
      false,
    );
  });

  it("rejects absolute paths and symlink escapes without modifying workspace files", async () => {
    const root = await createFixture();
    const outside = await createFixture();
    await createProject(root, "safe");
    await symlink(outside, path.join(root, "outside-link"));
    const before = await readFile(path.join(root, "safe", "package.json"), "utf8");

    await expect(auditWorkspaceProjects({ workspaceDir: root, roots: [outside] })).rejects.toThrow(
      "workspace-relative",
    );
    await expect(
      auditWorkspaceProjects({ workspaceDir: root, roots: ["outside-link"] }),
    ).rejects.toThrow("escapes the workspace");
    expect(await readFile(path.join(root, "safe", "package.json"), "utf8")).toBe(before);
  });
});
