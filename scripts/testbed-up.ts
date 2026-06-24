import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

const root = join(import.meta.dir, "..");
const cacheDir = join(root, "deploy", "testbed", ".cache");
const version = Bun.env.OPENSHELL_VERSION ?? "0.0.67";
const tag = version.startsWith("v") ? version : `v${version}`;
const dockerArch = normalizeDockerArch(
  await capture(["docker", "info", "--format", "{{.Architecture}}"])
);
const supervisorBin = join(cacheDir, "openshell-sandbox");
const openshellCliBin = join(cacheDir, "openshell-linux");
const gatewayConfig = join(cacheDir, "gateway.toml");
const openshellDataDir = join(cacheDir, "openshell-data");

await mkdir(cacheDir, { recursive: true });
await mkdir(openshellDataDir, { recursive: true });
await ensureReleaseBinary({
  asset: `openshell-sandbox-${dockerArch}-unknown-linux-gnu.tar.gz`,
  output: supervisorBin,
  expectedName: "openshell-sandbox"
});
await ensureReleaseBinary({
  asset: `openshell-${dockerArch}-unknown-linux-musl.tar.gz`,
  output: openshellCliBin,
  expectedName: "openshell"
});
await writeGatewayConfig(gatewayConfig, supervisorBin);
await writeComposeEnv();

await run([
  "docker",
  "compose",
  "-f",
  "deploy/testbed/compose/docker-compose.yml",
  "up",
  "-d",
  "--build"
], {
  ...process.env,
  OPENSHELL_SUPERVISOR_BIN_HOST_PATH: supervisorBin,
  OPENSHELL_CLI_BIN_HOST_PATH: openshellCliBin,
  OPENSHELL_GATEWAY_CONFIG_HOST_PATH: gatewayConfig,
  AGENT_RUNTIME_OPENSHELL_CLI_BIN:
    process.env.AGENT_RUNTIME_OPENSHELL_CLI_BIN ?? "/opt/openshell-cli/openshell",
  AGENT_RUNTIME_SANDBOX_TRANSPORT:
    process.env.AGENT_RUNTIME_SANDBOX_TRANSPORT ?? "cli"
});

async function writeGatewayConfig(path: string, supervisorPath: string) {
  const base = await readFile(
    join(root, "deploy", "dev", "compose", "openshell", "gateway.toml"),
    "utf8"
  );
  const grpcEndpoint =
    Bun.env.OPENSHELL_TESTBED_GATEWAY_GRPC_ENDPOINT ??
    `http://host.docker.internal:${Bun.env.OPENSHELL_TESTBED_PORT ?? "8080"}`;
  let config = base.replace(
    /grpc_endpoint\s*=\s*"[^"]+"/,
    `grpc_endpoint     = "${grpcEndpoint}"`
  );
  config = config.replaceAll("/var/lib/openshell", openshellDataDir);
  if (config.includes("supervisor_bin")) {
    config = config.replace(
      /supervisor_bin\s*=\s*"[^"]+"/,
      `supervisor_bin   = "${supervisorPath}"`
    );
  } else {
    config = config.replace(
      /(supervisor_image\s*=\s*"[^"]+"\n)/,
      `$1supervisor_bin   = "${supervisorPath}"\n`
    );
  }
  await writeFile(path, config);
}

async function writeComposeEnv() {
  await writeFile(
    join(root, "deploy", "testbed", "compose", ".env"),
    [
      `OPENSHELL_SUPERVISOR_BIN_HOST_PATH=${supervisorBin}`,
      `OPENSHELL_CLI_BIN_HOST_PATH=${openshellCliBin}`,
      `OPENSHELL_GATEWAY_CONFIG_HOST_PATH=${gatewayConfig}`,
      `OPENSHELL_DATA_HOST_DIR=${openshellDataDir}`,
      `AGENT_RUNTIME_OPENSHELL_CLI_BIN=/opt/openshell-cli/openshell`,
      `AGENT_RUNTIME_SANDBOX_TRANSPORT=cli`
    ].join("\n") + "\n"
  );
}

async function ensureReleaseBinary(input: {
  asset: string;
  output: string;
  expectedName: string;
}) {
  if (await exists(input.output)) {
    return;
  }
  const archive = join(cacheDir, input.asset);
  if (!(await exists(archive))) {
    const url = `https://github.com/NVIDIA/OpenShell/releases/download/${tag}/${input.asset}`;
    await run(["curl", "-fsSL", url, "-o", archive]);
  }
  const extractDir = join(cacheDir, `${basename(input.asset, ".tar.gz")}-extract`);
  await mkdir(extractDir, { recursive: true });
  await run(["tar", "-xzf", archive, "-C", extractDir]);
  const extracted = join(extractDir, input.expectedName);
  await run(["cp", extracted, input.output]);
  await run(["chmod", "+x", input.output]);
}

async function exists(path: string): Promise<boolean> {
  return await Bun.file(path).exists();
}

async function capture(argv: string[]): Promise<string> {
  const proc = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited
  ]);
  if (code !== 0) {
    throw new Error(`${argv.join(" ")} failed (${code}): ${stderr || stdout}`);
  }
  return stdout.trim();
}

async function run(argv: string[], env?: NodeJS.ProcessEnv): Promise<void> {
  const proc = Bun.spawn(argv, {
    cwd: root,
    env,
    stdout: "inherit",
    stderr: "inherit"
  });
  const code = await proc.exited;
  if (code !== 0) {
    throw new Error(`${argv.join(" ")} failed with exit ${code}`);
  }
}

function normalizeDockerArch(arch: string): string {
  switch (arch.trim()) {
    case "aarch64":
    case "arm64":
      return "aarch64";
    case "x86_64":
    case "amd64":
      return "x86_64";
    default:
      throw new Error(`Unsupported Docker architecture for OpenShell: ${arch}`);
  }
}
