import { readFile } from "node:fs/promises";
import YAML from "yaml";

interface PackageJson {
  version?: unknown;
}

interface HelmChart {
  version?: unknown;
  appVersion?: unknown;
}

const semverPattern = /^\d+\.\d+\.\d+$/;

async function main(): Promise<void> {
  const [
    packageJsonRaw,
    runtimeSdkPackageJsonRaw,
    chartRaw,
    changelog,
    releaseDocs,
    releaseWorkflow
  ] = await Promise.all([
    readFile("package.json", "utf8"),
    readFile("packages/runtime-sdk/package.json", "utf8"),
    readFile("deploy/k8s/chart/Chart.yaml", "utf8"),
    readFile("CHANGELOG.md", "utf8"),
    readFile("docs/releases.md", "utf8"),
    readFile(".github/workflows/release.yml", "utf8")
  ]);

  const packageJson = JSON.parse(packageJsonRaw) as PackageJson;
  const runtimeSdkPackageJson = JSON.parse(
    runtimeSdkPackageJsonRaw
  ) as PackageJson;
  const chart = YAML.parse(chartRaw) as HelmChart;

  const version = readSemver(
    packageJson.version,
    "package.json version must be SemVer without a leading v"
  );
  const tag = `v${version}`;

  expectEqual(
    runtimeSdkPackageJson.version,
    version,
    "packages/runtime-sdk/package.json version must match package.json"
  );
  expectEqual(
    chart.version,
    version,
    "deploy/k8s/chart/Chart.yaml version must match package.json"
  );
  expectEqual(
    chart.appVersion,
    version,
    "deploy/k8s/chart/Chart.yaml appVersion must match package.json"
  );

  expectText(changelog, "## [Unreleased]", "CHANGELOG.md must keep an Unreleased section");
  expectText(changelog, `## [${version}]`, `CHANGELOG.md must document ${version}`);
  expectText(releaseDocs, tag, `docs/releases.md must include the current release tag ${tag}`);
  expectText(releaseWorkflow, "v*.*.*", "release workflow must run for version tags");
  expectText(releaseWorkflow, "gh release create", "release workflow must create GitHub Releases");
}

function readSemver(value: unknown, message: string): string {
  if (typeof value !== "string" || !semverPattern.test(value)) {
    throw new Error(message);
  }
  return value;
}

function expectEqual(actual: unknown, expected: string, message: string): void {
  if (actual !== expected) {
    throw new Error(message);
  }
}

function expectText(content: string, needle: string, message: string): void {
  if (!content.includes(needle)) {
    throw new Error(message);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
