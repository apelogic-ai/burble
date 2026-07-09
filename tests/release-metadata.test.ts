import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import YAML from "yaml";

describe("release metadata", () => {
  test("documents the release process and current package version", async () => {
    const [packageJson, runtimeSdkPackageJson, chartRaw, changelog, releaseDocs, readme] =
      await Promise.all([
        readFile("package.json", "utf8"),
        readFile("packages/runtime-sdk/package.json", "utf8"),
        readFile("deploy/k8s/chart/Chart.yaml", "utf8"),
        readFile("CHANGELOG.md", "utf8"),
        readFile("docs/releases.md", "utf8"),
        readFile("README.md", "utf8")
      ]);

    const parsedPackage = JSON.parse(packageJson) as {
      version: string;
      scripts: Record<string, string>;
    };
    const parsedRuntimeSdkPackage = JSON.parse(runtimeSdkPackageJson) as {
      version: string;
    };
    const chart = YAML.parse(chartRaw) as {
      version: string;
      appVersion: string;
    };

    expect(parsedPackage.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(parsedRuntimeSdkPackage.version).toBe(parsedPackage.version);
    expect(chart.version).toBe(parsedPackage.version);
    expect(chart.appVersion).toBe(parsedPackage.version);
    expect(parsedPackage.scripts["release:check"]).toBe(
      "bun scripts/check-release-metadata.ts"
    );
    expect(changelog).toContain("## [Unreleased]");
    expect(changelog).toContain(`## [${parsedPackage.version}]`);
    expect(releaseDocs).toContain("SemVer");
    expect(releaseDocs).toContain(`v${parsedPackage.version}`);
    expect(releaseDocs).toContain("git tag -a vX.Y.Z");
    expect(readme).toContain("docs/releases.md");
    expect(readme).toContain("bun run release:check");
  });

  test("runs release metadata checks in CI and on version tags", async () => {
    const [ciWorkflow, releaseWorkflow] = await Promise.all([
      readFile(".github/workflows/ci.yml", "utf8"),
      readFile(".github/workflows/release.yml", "utf8")
    ]);

    expect(ciWorkflow).toContain("bun run release:check");
    expect(releaseWorkflow).toContain("tags:");
    expect(releaseWorkflow).toContain("v*.*.*");
    expect(releaseWorkflow).toContain("bun run ci");
    expect(releaseWorkflow).toContain("bun run deploy:check");
    expect(releaseWorkflow).toContain("bun run release:check");
    expect(releaseWorkflow).toContain("gh release create");
    expect(releaseWorkflow).toContain("--generate-notes");
  });
});
