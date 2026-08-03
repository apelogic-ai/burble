import { readdirSync, readFileSync } from "node:fs";
import { basename, extname } from "node:path";
import { pathToFileURL } from "node:url";
import YAML from "yaml";

export type RuntimeSkillDefinition = {
  id: string;
  version: string;
  toolGroups: string[];
  content: string;
};

export type RuntimeSkillEnablement = {
  id: string;
  version: string;
  enabled: boolean;
};

export function loadRuntimeSkills(
  directories: Array<string | URL>
): RuntimeSkillDefinition[] {
  const skills: RuntimeSkillDefinition[] = [];
  const seen = new Set<string>();

  for (const directory of directories) {
    for (const filename of runtimeSkillFilenames(directory)) {
      const source = readFileSync(new URL(filename, directoryUrl(directory)), "utf8");
      const skill = parseRuntimeSkill(source, filename);
      const key = `${skill.id}@${skill.version}`;
      if (seen.has(key)) {
        throw new Error(`Duplicate runtime skill ${key}`);
      }
      seen.add(key);
      skills.push(skill);
    }
  }

  return skills.sort(
    (left, right) =>
      left.id.localeCompare(right.id) || left.version.localeCompare(right.version)
  );
}

export function selectRuntimeSkills(
  skills: RuntimeSkillDefinition[],
  input: {
    enabledSkills: RuntimeSkillEnablement[];
    selectedToolGroups: ReadonlySet<string> | null;
  }
): RuntimeSkillDefinition[] {
  const enabled = new Set(
    input.enabledSkills
      .filter((skill) => skill.enabled)
      .map((skill) => `${skill.id}@${skill.version}`)
  );

  // Provider/tool-group matching is intentionally the first small selector.
  // It may evolve into semantic or on-demand selection without changing how
  // skills are stored, discovered, versioned, or enabled by runtime policy.
  return skills.filter(
    (skill) =>
      enabled.has(`${skill.id}@${skill.version}`) &&
      (skill.toolGroups.length === 0 ||
        input.selectedToolGroups === null ||
        skill.toolGroups.some((group) => input.selectedToolGroups!.has(group)))
  );
}

function runtimeSkillFilenames(directory: string | URL): string[] {
  try {
    return readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && extname(entry.name) === ".md")
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    if (isMissingDirectoryError(error)) {
      return [];
    }
    throw error;
  }
}

function parseRuntimeSkill(
  source: string,
  filename: string
): RuntimeSkillDefinition {
  const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) {
    throw new Error(`Runtime skill ${filename} is missing YAML frontmatter`);
  }

  let metadata: unknown;
  try {
    metadata = YAML.parse(match[1] ?? "");
  } catch {
    throw new Error(`Runtime skill ${filename} has invalid YAML frontmatter`);
  }
  if (!isRecord(metadata)) {
    throw new Error(`Runtime skill ${filename} has invalid metadata`);
  }

  const id = readIdentifier(metadata.id);
  const version = readNonEmptyString(metadata.version);
  const toolGroups = readStringArray(metadata.toolGroups);
  const content = (match[2] ?? "").trim();
  if (!id || !version || !toolGroups || !content) {
    throw new Error(`Runtime skill ${filename} has invalid metadata or content`);
  }
  if (basename(filename, extname(filename)) !== id) {
    throw new Error(`Runtime skill ${filename} must declare id ${basename(filename, extname(filename))}`);
  }

  return { id, version, toolGroups, content };
}

function directoryUrl(directory: string | URL): URL {
  if (directory instanceof URL) {
    return directory.href.endsWith("/") ? directory : new URL(`${directory.href}/`);
  }
  const url = pathToFileURL(directory);
  return url.href.endsWith("/") ? url : new URL(`${url.href}/`);
}

function readIdentifier(value: unknown): string | null {
  const text = readNonEmptyString(value);
  return text && /^[a-z0-9][a-z0-9._-]*$/.test(text) ? text : null;
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readStringArray(value: unknown): string[] | null {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    return null;
  }
  const strings = value.map(readNonEmptyString);
  return strings.every((item): item is string => item !== null) ? strings : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isMissingDirectoryError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as Error & { code?: string }).code === "ENOENT"
  );
}
