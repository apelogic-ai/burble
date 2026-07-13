import {
  printResult,
  runOnce,
  type BenchOptions,
  type BenchResult
} from "./runtime-bench";

const composeFile = "deploy/testbed/compose/docker-compose.llm-ab.yml";
const directUrl = Bun.env.LLM_AB_DIRECT_URL ?? "http://127.0.0.1:18080";
const litellmUrl = Bun.env.LLM_AB_LITELLM_URL ?? "http://127.0.0.1:18081";

async function main(): Promise<void> {
  const [command = "run", ...args] = process.argv.slice(2);
  if (command === "up") {
    await compose(["up", "-d", "--build"]);
    await Promise.all([waitForHealth(directUrl), waitForHealth(litellmUrl)]);
    console.log(`direct=${directUrl} litellm=${litellmUrl}`);
    return;
  }
  if (command === "down") {
    await compose(["down", "--remove-orphans"]);
    return;
  }
  if (command === "logs") {
    await compose(["logs", "--tail", "200", ...args]);
    return;
  }
  if (command !== "run") {
    throw new Error("Usage: bun run llm-ab <up|run|logs|down> [options]");
  }

  const input = parseRunArgs(args);
  await Promise.all([waitForHealth(directUrl), waitForHealth(litellmUrl)]);
  const results: BenchResult[] = [];
  const soakStartedAt = Date.now();
  for (let iteration = 1; iteration <= input.iterations; iteration += 1) {
    const targets = iteration % 2 === 1
      ? [["direct", directUrl], ["litellm", litellmUrl]]
      : [["litellm", litellmUrl], ["direct", directUrl]];
    for (const [label, url] of targets) {
      const options: BenchOptions = {
        url,
        label,
        iterations: 1,
        warmup: 0,
        stream: true,
        executionMode: "openclaw-native",
        routeId: `convrt_ab_${iteration}_${label}`,
        token: "bench-internal-token",
        scheduled: input.scheduled,
        questions: [input.question]
      };
      const result = await runOnce(options, input.question, iteration);
      results.push(result);
      printResult(result);
    }
    if (iteration < input.iterations && input.intervalSeconds > 0) {
      const nextIterationAt =
        soakStartedAt + iteration * input.intervalSeconds * 1_000;
      const delayMs = nextIterationDelayMs(
        soakStartedAt,
        iteration,
        input.intervalSeconds,
        Date.now()
      );
      console.log(
        `nextIteration=${iteration + 1} waitMs=${delayMs} scheduledAt=${new Date(nextIterationAt).toISOString()}`
      );
      await Bun.sleep(delayMs);
    }
  }
  printComparison(results);
}

export function nextIterationDelayMs(
  startedAt: number,
  completedIterations: number,
  intervalSeconds: number,
  now: number
): number {
  return Math.max(
    0,
    startedAt + completedIterations * intervalSeconds * 1_000 - now
  );
}

async function compose(args: string[]): Promise<void> {
  const proc = Bun.spawn(
    ["docker", "compose", "--env-file", ".env", "-f", composeFile, ...args],
    { stdout: "inherit", stderr: "inherit", env: process.env }
  );
  const code = await proc.exited;
  if (code !== 0) {
    throw new Error(`docker compose failed with exit ${code}`);
  }
}

async function waitForHealth(url: string): Promise<void> {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const response = await fetch(`${url}/healthz`).catch(() => null);
    if (response?.ok) {
      return;
    }
    await Bun.sleep(1_000);
  }
  throw new Error(`Runtime did not become healthy: ${url}`);
}

function parseRunArgs(args: string[]): {
  iterations: number;
  intervalSeconds: number;
  question: string;
  scheduled: boolean;
} {
  let iterations = 10;
  let intervalSeconds = 0;
  let question = "Reply exactly with: ok. Do not use tools.";
  let scheduled = true;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    const value = () => args[++index] ?? "";
    if (arg === "--iterations") {
      iterations = Number.parseInt(value(), 10);
    } else if (arg === "--interval-seconds") {
      intervalSeconds = Number.parseInt(value(), 10);
    } else if (arg === "--question") {
      question = value();
    } else if (arg === "--scheduled") {
      scheduled = value().toLowerCase() !== "false";
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  if (!Number.isInteger(iterations) || iterations <= 0) {
    throw new Error("--iterations must be a positive integer");
  }
  if (!Number.isInteger(intervalSeconds) || intervalSeconds < 0) {
    throw new Error("--interval-seconds must be a non-negative integer");
  }
  return { iterations, intervalSeconds, question, scheduled };
}

function printComparison(results: BenchResult[]): void {
  console.log("");
  for (const label of ["direct", "litellm"]) {
    const arm = results.filter((result) => result.label === label);
    const ok = arm.filter((result) => result.ok);
    const sorted = ok.map((result) => result.finalMs).sort((a, b) => a - b);
    const p50 = sorted[Math.floor((sorted.length - 1) * 0.5)] ?? "n/a";
    const p90 = sorted[Math.floor((sorted.length - 1) * 0.9)] ?? "n/a";
    console.log(
      `label=${label} runs=${arm.length} ok=${ok.length} failed=${arm.length - ok.length} finalMs.p50=${p50} finalMs.p90=${p90}`
    );
  }
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
