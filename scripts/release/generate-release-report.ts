import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { evaluateEcrScan } from "./wait-for-ecr-scan";

export async function generateReleaseReport(input: {
  artifactsDirectory: string;
  outputPath: string;
  version: string;
  registry: string;
  imageRepository: string;
  chartRepository: string;
}): Promise<void> {
  validateVersion(input.version);
  validateRegistry(input.registry);
  validateRepository(input.imageRepository, "image");
  validateRepository(input.chartRepository, "chart");
  if (basename(input.chartRepository) !== "burble") {
    throw new Error("Chart repository basename must match the chart name burble");
  }

  const [imageDigest, chartDigest, scanRaw] = await Promise.all([
    readDigest(join(input.artifactsDirectory, "image.digest")),
    readDigest(join(input.artifactsDirectory, "chart.digest")),
    readFile(join(input.artifactsDirectory, "ecr-image-scan.json"), "utf8")
  ]);
  const scan = evaluateEcrScan(parseJson(scanRaw, "ECR image scan"));
  if (!scan) {
    throw new Error("ECR image scan is not complete");
  }

  const imageReference = `${input.registry}/${input.imageRepository}@${imageDigest}`;
  const chartReference = `oci://${input.registry}/${input.chartRepository}@${chartDigest}`;
  const report = `# Burble v${input.version} release report

## Immutable artifacts

| Artifact | Immutable reference | Digest |
| --- | --- | --- |
| Linux/amd64 application image | \`${imageReference}\` | \`${imageDigest}\` |
| Helm chart | \`${chartReference}\` | \`${chartDigest}\` |

## Registry scan gate

| Check | Result |
| --- | --- |
| ECR scan status | \`${scan.status}\` |
| Unresolved critical findings | \`${scan.criticalFindings}\` |

Both OCI artifacts are signed by digest. Their OCI references carry SBOM,
build-provenance, and vulnerability-scan attestations.

## Attached evidence

- \`burble-image.spdx.json\`
- \`burble-image.provenance.json\`
- \`burble-image.scan.json\`
- \`ecr-image-scan.json\`
- \`burble-chart.spdx.json\`
- \`burble-chart.provenance.json\`
- \`burble-chart.scan.json\`
- \`burble-${input.version}.tgz\`
`;

  await mkdir(dirname(input.outputPath), { recursive: true });
  await writeFile(input.outputPath, report);
}

async function readDigest(path: string): Promise<string> {
  const value = (await readFile(path, "utf8")).trim();
  if (!/^sha256:[a-f0-9]{64}$/.test(value)) {
    throw new Error(`${path} does not contain a valid OCI digest`);
  }
  return value;
}

function parseJson(value: string, name: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    throw new Error(`${name} is not valid JSON`);
  }
}

function validateVersion(value: string): void {
  if (!/^\d+\.\d+\.\d+$/.test(value)) {
    throw new Error("Release version must be SemVer without a leading v");
  }
}

function validateRegistry(value: string): void {
  if (!/^[a-z0-9.-]+$/.test(value)) {
    throw new Error("ECR registry hostname is invalid");
  }
}

function validateRepository(value: string, kind: string): void {
  if (!/^[a-z0-9]+(?:[._/-][a-z0-9]+)*$/.test(value)) {
    throw new Error(`ECR ${kind} repository name is invalid`);
  }
}

function argumentValue(name: string): string {
  const index = Bun.argv.indexOf(name);
  const value = index >= 0 ? Bun.argv[index + 1] : undefined;
  if (!value) {
    throw new Error(`Missing required argument ${name}`);
  }
  return value;
}

if (import.meta.main) {
  generateReleaseReport({
    artifactsDirectory: argumentValue("--artifacts"),
    outputPath: argumentValue("--output"),
    version: argumentValue("--version"),
    registry: argumentValue("--registry"),
    imageRepository: argumentValue("--image-repository"),
    chartRepository: argumentValue("--chart-repository")
  }).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
