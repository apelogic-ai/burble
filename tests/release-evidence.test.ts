import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  evaluateEcrScan,
  waitForEcrScan,
  type AwsCommandRunner
} from "../scripts/release/wait-for-ecr-scan";
import { generateReleaseReport } from "../scripts/release/generate-release-report";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    )
  );
});

describe("release evidence", () => {
  test("waits for ECR scanning and records a zero-critical report", async () => {
    const directory = await temporaryDirectory();
    const outputPath = join(directory, "ecr-image-scan.json");
    const calls: string[][] = [];
    const responses = [
      scanResponse("IN_PROGRESS", 0),
      scanResponse("COMPLETE", 0)
    ];
    const runAws: AwsCommandRunner = async (args) => {
      calls.push(args);
      return { exitCode: 0, stdout: JSON.stringify(responses.shift()), stderr: "" };
    };

    const result = await waitForEcrScan({
      repository: "platform/burble",
      digest: digest("a"),
      outputPath,
      attempts: 2,
      intervalMs: 0,
      runAws
    });

    expect(result).toEqual({ status: "COMPLETE", criticalFindings: 0 });
    expect(calls).toHaveLength(2);
    expect(JSON.parse(await readFile(outputPath, "utf8"))).toEqual(
      scanResponse("COMPLETE", 0)
    );
  });

  test("starts a missing basic scan and rejects unresolved critical findings", async () => {
    const directory = await temporaryDirectory();
    const calls: string[][] = [];
    const runAws: AwsCommandRunner = async (args) => {
      calls.push(args);
      if (calls.length === 1) {
        return {
          exitCode: 254,
          stdout: "",
          stderr: "ScanNotFoundException: scan does not exist"
        };
      }
      if (args[1] === "start-image-scan") {
        return { exitCode: 0, stdout: "{}", stderr: "" };
      }
      return {
        exitCode: 0,
        stdout: JSON.stringify(scanResponse("COMPLETE", 2)),
        stderr: ""
      };
    };

    await expect(
      waitForEcrScan({
        repository: "platform/burble",
        digest: digest("b"),
        outputPath: join(directory, "scan.json"),
        attempts: 2,
        intervalMs: 0,
        runAws
      })
    ).rejects.toThrow("ECR scan has 2 unresolved critical findings");
    expect(calls.some((args) => args[1] === "start-image-scan")).toBe(true);
  });

  test("accepts enhanced scanning ACTIVE status and rejects failed scans", () => {
    expect(evaluateEcrScan(scanResponse("ACTIVE", 0))).toEqual({
      status: "ACTIVE",
      criticalFindings: 0
    });
    expect(() => evaluateEcrScan(scanResponse("FAILED", 0))).toThrow(
      "ECR scan failed with status FAILED"
    );
  });

  test("generates a private GitOps release report from immutable digests", async () => {
    const directory = await temporaryDirectory();
    await Promise.all([
      writeFile(join(directory, "image.digest"), `${digest("c")}\n`),
      writeFile(join(directory, "image-platform.digest"), `${digest("e")}\n`),
      writeFile(join(directory, "chart.digest"), `${digest("d")}\n`),
      writeFile(
        join(directory, "ecr-image-scan.json"),
        JSON.stringify(scanResponse("COMPLETE", 0))
      )
    ]);
    const outputPath = join(directory, "release-report.md");

    await generateReleaseReport({
      artifactsDirectory: directory,
      outputPath,
      version: "1.2.3",
      registry: "123456789012.dkr.ecr.us-east-1.amazonaws.com",
      imageRepository: "platform/burble-app",
      chartRepository: "platform/charts/burble"
    });

    const report = await readFile(outputPath, "utf8");
    expect(report).toContain(
      `123456789012.dkr.ecr.us-east-1.amazonaws.com/platform/burble-app@${digest("c")}`
    );
    expect(report).toContain(
      `oci://123456789012.dkr.ecr.us-east-1.amazonaws.com/platform/charts/burble@${digest("d")}`
    );
    expect(report).toContain("Unresolved critical findings | `0`");
    expect(report).toContain(`Scanned Linux/amd64 manifest | \`${digest("e")}\``);
    expect(report).toContain("burble-image.spdx.json");
    expect(report).toContain("burble-chart.provenance.json");
  });
});

function scanResponse(status: string, critical: number): object {
  return {
    imageScanStatus: { status },
    imageScanFindings: {
      findingSeverityCounts: { CRITICAL: critical }
    }
  };
}

function digest(character: string): string {
  return `sha256:${character.repeat(64)}`;
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "burble-release-evidence-"));
  temporaryDirectories.push(directory);
  return directory;
}
