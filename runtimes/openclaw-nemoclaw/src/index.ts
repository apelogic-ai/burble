import { readRuntimeConfig } from "./config";
import { info } from "./logger";
import { handleRuntimeRequest } from "./server";
import { ensureOpenClawSetup } from "./setup";

const config = readRuntimeConfig(Bun.env);

await ensureOpenClawSetup(config);

const server = Bun.serve({
  port: config.port,
  fetch: (request) => handleRuntimeRequest(request, config)
});

info(
  `OpenClaw/NemoClaw Burble runtime listening on http://localhost:${server.port}`
);

process.on("SIGINT", () => {
  server.stop();
  process.exit(0);
});

process.on("SIGTERM", () => {
  server.stop();
  process.exit(0);
});
