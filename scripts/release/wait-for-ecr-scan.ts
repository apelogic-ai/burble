import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export type AwsCommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

export type AwsCommandRunner = (args: string[]) => Promise<AwsCommandResult>;

export type EcrScanResult = {
  status: "ACTIVE" | "COMPLETE";
  criticalFindings: number;
};

export async function waitForEcrScan(input: {
  repository: string;
  digest: string;
  outputPath: string;
  attempts: number;
  intervalMs: number;
  runAws?: AwsCommandRunner;
}): Promise<EcrScanResult> {
  validateRepository(input.repository);
  validateDigest(input.digest);
  if (!Number.isInteger(input.attempts) || input.attempts < 1) {
    throw new Error("ECR scan attempts must be a positive integer");
  }
  if (!Number.isFinite(input.intervalMs) || input.intervalMs < 0) {
    throw new Error("ECR scan interval must be non-negative");
  }

  const runAws = input.runAws ?? runAwsCommand;
  let scanStarted = false;
  for (let attempt = 1; attempt <= input.attempts; attempt += 1) {
    const response = await runAws([
      "ecr",
      "describe-image-scan-findings",
      "--repository-name",
      input.repository,
      "--image-id",
      `imageDigest=${input.digest}`,
      "--output",
      "json"
    ]);
    if (response.exitCode !== 0) {
      if (!scanStarted && response.stderr.includes("ScanNotFoundException")) {
        const start = await runAws([
          "ecr",
          "start-image-scan",
          "--repository-name",
          input.repository,
          "--image-id",
          `imageDigest=${input.digest}`,
          "--output",
          "json"
        ]);
        if (start.exitCode !== 0) {
          throw new Error(`Unable to start ECR scan: ${bounded(start.stderr)}`);
        }
        scanStarted = true;
      } else {
        throw new Error(`Unable to read ECR scan: ${bounded(response.stderr)}`);
      }
    } else {
      const report = parseScanReport(response.stdout);
      const result = evaluateEcrScan(report);
      if (result) {
        await mkdir(dirname(input.outputPath), { recursive: true });
        await writeFile(input.outputPath, `${JSON.stringify(report, null, 2)}\n`);
        return result;
      }
    }

    if (attempt < input.attempts && input.intervalMs > 0) {
      await Bun.sleep(input.intervalMs);
    }
  }

  throw new Error(`ECR scan did not complete after ${input.attempts} attempts`);
}

export function evaluateEcrScan(report: unknown): EcrScanResult | null {
  const root = requireRecord(report, "ECR scan response");
  const scanStatus = requireRecord(root.imageScanStatus, "imageScanStatus");
  const status = requireString(scanStatus.status, "imageScanStatus.status").toUpperCase();
  if (["FAILED", "CANCELLED", "UNSUPPORTED_IMAGE"].includes(status)) {
    throw new Error(`ECR scan failed with status ${status}`);
  }
  if (status !== "COMPLETE" && status !== "ACTIVE") {
    return null;
  }

  const findings = requireRecord(root.imageScanFindings, "imageScanFindings");
  const severityCounts = findings.findingSeverityCounts;
  const criticalFindings = isRecord(severityCounts)
    ? optionalNonNegativeNumber(severityCounts.CRITICAL, "CRITICAL")
    : 0;
  if (criticalFindings > 0) {
    throw new Error(
      `ECR scan has ${criticalFindings} unresolved critical findings`
    );
  }
  return {
    status: status as EcrScanResult["status"],
    criticalFindings
  };
}

async function runAwsCommand(args: string[]): Promise<AwsCommandResult> {
  const process = Bun.spawn(["aws", ...args], {
    stdout: "pipe",
    stderr: "pipe"
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text()
  ]);
  return { exitCode, stdout, stderr };
}

function parseScanReport(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    throw new Error("AWS returned invalid JSON for the ECR scan");
  }
}

function validateRepository(value: string): void {
  if (!/^[a-z0-9]+(?:[._/-][a-z0-9]+)*$/.test(value)) {
    throw new Error("ECR repository name is invalid");
  }
}

function validateDigest(value: string): void {
  if (!/^sha256:[a-f0-9]{64}$/.test(value)) {
    throw new Error("OCI digest must be sha256:<64 lowercase hex characters>");
  }
}

function optionalNonNegativeNumber(value: unknown, name: string): number {
  if (value === undefined) {
    return 0;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(`ECR scan ${name} count is invalid`);
  }
  return value;
}

function requireRecord(value: unknown, name: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`${name} is missing or invalid`);
  }
  return value;
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${name} is missing or invalid`);
  }
  return value.trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function bounded(value: string): string {
  const normalized = value.trim().replace(/\s+/g, " ");
  return normalized.slice(0, 500) || "unknown AWS CLI failure";
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
  waitForEcrScan({
    repository: argumentValue("--repository"),
    digest: argumentValue("--digest"),
    outputPath: argumentValue("--output"),
    attempts: Number(Bun.env.ECR_SCAN_ATTEMPTS ?? "60"),
    intervalMs: Number(Bun.env.ECR_SCAN_INTERVAL_MS ?? "10000")
  }).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
