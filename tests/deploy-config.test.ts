import { describe, expect, test } from "bun:test";

const compose = await Bun.file("deploy/dev/compose/docker-compose.yml").text();
const openClawCompose = await Bun.file(
  "deploy/dev/compose/docker-compose.openclaw-nemoclaw.yml"
).text();
const caddyfile = await Bun.file("deploy/dev/compose/Caddyfile").text();

describe("dev deploy config", () => {
  test("runs the Burble Bun app behind Caddy", () => {
    expect(compose).toContain("burble-app:");
    expect(compose).toContain("dockerfile: Dockerfile");
    expect(compose).toContain('"3000"');
    expect(compose).toContain("http://localhost:3000/healthz");
    expect(caddyfile).toContain("reverse_proxy burble-app:3000");
  });

  test("passes Slack and GitHub OAuth settings to the app", () => {
    for (const name of [
      "SLACK_BOT_TOKEN:?SLACK_BOT_TOKEN is required",
      "SLACK_APP_TOKEN:?SLACK_APP_TOKEN is required",
      "SLACK_LOG_LEVEL",
      "AGENT_MODE",
      "AGENT_RUNTIME",
      "AI_MODEL",
      "OPENCLAW_NEMOCLAW_URL",
      "INTERNAL_API_TOKEN",
      "OPENAI_API_KEY",
      "ANTHROPIC_API_KEY",
      "GITHUB_CLIENT_ID:?GITHUB_CLIENT_ID is required",
      "GITHUB_CLIENT_SECRET:?GITHUB_CLIENT_SECRET is required",
      "BASE_URL",
      "DATABASE_PATH"
    ]) {
      expect(compose).toContain(name);
    }
  });

  test("requires the public domain before starting Caddy", () => {
    expect(compose).toContain("DOMAIN=${DOMAIN:?DOMAIN is required}");
    expect(compose).toContain("BASE_URL=https://${DOMAIN:?DOMAIN is required}");
  });

  test("does not reference Observer runtime service names", () => {
    expect(compose).not.toContain("observer-api");
    expect(compose).not.toContain("OBSERVER_");
    expect(compose).not.toContain("AI_GATEWAY");
    expect(caddyfile).not.toContain("ingestor");
  });

  test("does not expose internal tool endpoints through Caddy", () => {
    expect(caddyfile).toContain("@internal path /internal/*");
    expect(caddyfile).toContain("respond @internal 404");
  });

  test("provides an optional OpenClaw/NemoClaw compose override", () => {
    expect(openClawCompose).toContain("openclaw-nemoclaw:");
    expect(openClawCompose).toContain("AGENT_RUNTIME=openclaw-nemoclaw");
    expect(openClawCompose).toContain(
      "OPENCLAW_NEMOCLAW_URL=http://openclaw-nemoclaw:8080"
    );
    expect(openClawCompose).toContain("context: ../../../runtimes/openclaw-nemoclaw");
    expect(openClawCompose).toContain("dockerfile: Dockerfile");
    expect(openClawCompose).toContain(
      "OPENCLAW_NEMOCLAW_IMAGE:-burble-openclaw-nemoclaw:dev"
    );
    expect(openClawCompose).toContain(
      "INTERNAL_API_TOKEN:?INTERNAL_API_TOKEN is required"
    );
    expect(openClawCompose).toContain("BURBLE_TOOL_GATEWAY_URL");
    expect(openClawCompose).toContain("BURBLE_INTERNAL_TOKEN");
    expect(openClawCompose).toContain(
      "OPENCLAW_NEMOCLAW_ENGINE=${OPENCLAW_NEMOCLAW_ENGINE:-deterministic}"
    );
    expect(openClawCompose).toContain("OPENCLAW_COMMAND=${OPENCLAW_COMMAND:-openclaw}");
    expect(openClawCompose).toContain("OPENCLAW_AGENT=${OPENCLAW_AGENT:-main}");
  });
});
