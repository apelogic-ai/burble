import { describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { extname, join, relative, resolve, sep } from "node:path";

const runtimeRoots = [
  "runtimes/openclaw-nemoclaw",
  "runtimes/burble-native",
  "runtimes/nemo-hermes"
] as const;

const sourceExtensions = new Set([".ts", ".js", ".mjs", ".cjs", ".py"]);
const ignoredPathParts = new Set(["node_modules", "__pycache__"]);
const allowedBurblePackages = new Set(["@burble/runtime-sdk"]);

describe("runtime import boundary", () => {
  test("runtime packages do not import Burble control-plane modules", async () => {
    const violations: string[] = [];

    for (const root of runtimeRoots) {
      const absoluteRoot = resolve(root);
      for (const file of await listRuntimeSourceFiles(root)) {
        const text = await readFile(file, "utf8");
        for (const specifier of importSpecifiers(text, file)) {
          if (specifier.startsWith(".")) {
            const resolved = resolve(join(file, ".."), specifier);
            if (!isInside(resolved, absoluteRoot)) {
              violations.push(
                `${file} imports ${specifier}, which resolves outside ${root}`
              );
            }
            continue;
          }

          const burblePackage = burblePackageName(specifier);
          if (burblePackage && !allowedBurblePackages.has(burblePackage)) {
            violations.push(
              `${file} imports ${specifier}; runtimes may only import @burble/runtime-sdk`
            );
          }
        }
      }
    }

    expect(violations).toEqual([]);
  });

  test("runtime package manifests depend only on the runtime SDK within @burble", async () => {
    const violations: string[] = [];

    for (const packageJsonPath of await listRuntimePackageJsonFiles()) {
      const manifest = JSON.parse(await readFile(packageJsonPath, "utf8")) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
        peerDependencies?: Record<string, string>;
        optionalDependencies?: Record<string, string>;
      };
      for (const [field, dependencies] of Object.entries({
        dependencies: manifest.dependencies,
        devDependencies: manifest.devDependencies,
        peerDependencies: manifest.peerDependencies,
        optionalDependencies: manifest.optionalDependencies
      })) {
        for (const dependency of Object.keys(dependencies ?? {})) {
          if (
            dependency.startsWith("@burble/") &&
            !allowedBurblePackages.has(dependency)
          ) {
            violations.push(
              `${packageJsonPath} ${field} includes ${dependency}; runtimes may only depend on @burble/runtime-sdk`
            );
          }
        }
      }
    }

    expect(violations).toEqual([]);
  });
});

async function listRuntimeSourceFiles(root: string): Promise<string[]> {
  const files: string[] = [];

  async function visit(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (ignoredPathParts.has(entry.name)) {
        continue;
      }
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        await visit(path);
        continue;
      }
      if (entry.isFile() && sourceExtensions.has(extname(entry.name))) {
        files.push(path);
      }
    }
  }

  await visit(root);
  return files.sort();
}

async function listRuntimePackageJsonFiles(): Promise<string[]> {
  const files: string[] = [];

  async function visit(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (ignoredPathParts.has(entry.name)) {
        continue;
      }
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        await visit(path);
        continue;
      }
      if (entry.isFile() && entry.name === "package.json") {
        files.push(path);
      }
    }
  }

  for (const root of runtimeRoots) {
    await visit(root);
  }
  return files.sort();
}

function importSpecifiers(text: string, file: string): string[] {
  if (file.endsWith(".py")) {
    return pythonImportSpecifiers(text);
  }
  return tsImportSpecifiers(text);
}

function tsImportSpecifiers(text: string): string[] {
  const specifiers: string[] = [];
  const importPattern =
    /\b(?:import|export)\s+(?:type\s+)?(?:[^'"]*?\s+from\s+)?["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)|require\(\s*["']([^"']+)["']\s*\)/g;
  for (const match of text.matchAll(importPattern)) {
    const specifier = match[1] ?? match[2] ?? match[3];
    if (specifier) {
      specifiers.push(specifier);
    }
  }
  return specifiers;
}

function pythonImportSpecifiers(text: string): string[] {
  const specifiers: string[] = [];
  const fromPattern = /^\s*from\s+([A-Za-z_][\w.]*)\s+import\s+/gm;
  const importPattern = /^\s*import\s+([A-Za-z_][\w.]*)(?:\s+as\s+\w+)?\s*$/gm;
  for (const match of text.matchAll(fromPattern)) {
    if (match[1]) {
      specifiers.push(match[1]);
    }
  }
  for (const match of text.matchAll(importPattern)) {
    if (match[1]) {
      specifiers.push(match[1]);
    }
  }
  return specifiers;
}

function burblePackageName(specifier: string): string | null {
  if (!specifier.startsWith("@burble/")) {
    return null;
  }
  const [scope, name] = specifier.split("/");
  return scope && name ? `${scope}/${name}` : specifier;
}

function isInside(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !rel.startsWith(sep));
}
