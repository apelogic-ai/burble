import { join } from "node:path";

const root = join(import.meta.dir, "..");
const cacheDir = join(root, "deploy", "testbed", ".cache");

const proc = Bun.spawn(
  [
    "docker",
    "compose",
    "-f",
    "deploy/testbed/compose/docker-compose.yml",
    "down",
    "--remove-orphans"
  ],
  {
    cwd: root,
    env: {
      ...process.env,
      OPENSHELL_SUPERVISOR_BIN_HOST_PATH: join(cacheDir, "openshell-sandbox"),
      OPENSHELL_CLI_BIN_HOST_PATH: join(cacheDir, "openshell-linux"),
      OPENSHELL_GATEWAY_CONFIG_HOST_PATH: join(cacheDir, "gateway.toml"),
      OPENSHELL_DATA_HOST_DIR: join(cacheDir, "openshell-data")
    },
    stdout: "inherit",
    stderr: "inherit"
  }
);

const code = await proc.exited;
if (code !== 0) {
  throw new Error(`docker compose down failed with exit ${code}`);
}
