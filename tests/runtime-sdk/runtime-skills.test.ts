import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadRuntimeSkills,
  selectRuntimeSkills
} from "../../packages/runtime-sdk/src/runtime-skills";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("runtime skill loader", () => {
  test("discovers metadata-bearing Markdown skills without code registration", () => {
    const directory = temporarySkillDirectory();
    writeSkill(directory, "alpha.md", {
      id: "alpha",
      version: "1",
      toolGroups: ["google"],
      content: "# Alpha skill\n\nUse alpha tools."
    });
    writeSkill(directory, "beta.md", {
      id: "beta",
      version: "2",
      toolGroups: ["github", "jira"],
      content: "# Beta skill\n\nUse beta tools."
    });

    expect(loadRuntimeSkills([directory])).toEqual([
      {
        id: "alpha",
        version: "1",
        toolGroups: ["google"],
        content: "# Alpha skill\n\nUse alpha tools."
      },
      {
        id: "beta",
        version: "2",
        toolGroups: ["github", "jira"],
        content: "# Beta skill\n\nUse beta tools."
      }
    ]);
  });

  test("selects enabled skill versions relevant to the current tool groups", () => {
    const skills = [
      {
        id: "core",
        version: "1",
        toolGroups: [] as string[],
        content: "core"
      },
      {
        id: "google-workspace",
        version: "1",
        toolGroups: ["google"],
        content: "google"
      },
      {
        id: "github",
        version: "1",
        toolGroups: ["github"],
        content: "github"
      }
    ];

    expect(
      selectRuntimeSkills(skills, {
        enabledSkills: [
          { id: "core", version: "1", enabled: true },
          { id: "google-workspace", version: "1", enabled: true },
          { id: "github", version: "2", enabled: true }
        ],
        selectedToolGroups: new Set(["google"])
      }).map((skill) => skill.id)
    ).toEqual(["core", "google-workspace"]);
  });

  test("rejects malformed and duplicate skill definitions", () => {
    const first = temporarySkillDirectory();
    const second = temporarySkillDirectory();
    writeFileSync(join(first, "invalid.md"), "# Missing metadata\n");
    expect(() => loadRuntimeSkills([first])).toThrow(
      "Runtime skill invalid.md is missing YAML frontmatter"
    );

    writeSkill(first, "duplicate.md", {
      id: "duplicate",
      version: "1",
      toolGroups: [],
      content: "first"
    });
    rmSync(join(first, "invalid.md"));
    writeSkill(second, "duplicate.md", {
      id: "duplicate",
      version: "1",
      toolGroups: [],
      content: "second"
    });
    expect(() => loadRuntimeSkills([first, second])).toThrow(
      "Duplicate runtime skill duplicate@1"
    );
  });
});

function temporarySkillDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "burble-runtime-skills-"));
  temporaryDirectories.push(directory);
  return directory;
}

function writeSkill(
  directory: string,
  filename: string,
  skill: {
    id: string;
    version: string;
    toolGroups: string[];
    content: string;
  }
): void {
  writeFileSync(
    join(directory, filename),
    [
      "---",
      `id: ${skill.id}`,
      `version: \"${skill.version}\"`,
      `toolGroups: [${skill.toolGroups.join(", ")}]`,
      "---",
      skill.content,
      ""
    ].join("\n")
  );
}
