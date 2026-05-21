import { describe, expect, test } from "bun:test";

const compose = await Bun.file("deploy/dev/compose/docker-compose.yml").text();
const openClawCompose = await Bun.file(
  "deploy/dev/compose/docker-compose.openclaw-nemoclaw.yml"
).text();
const openClawCliCompose = await Bun.file(
  "deploy/dev/compose/docker-compose.openclaw-cli.yml"
).text();
const personalRuntimesCompose = await Bun.file(
  "deploy/dev/compose/docker-compose.personal-runtimes.yml"
).text();
const caddyfile = await Bun.file("deploy/dev/compose/Caddyfile").text();
const openClawOpenAiPatch = await Bun.file(
  "deploy/dev/compose/openclaw-patches/openai.json5"
).text();
const ansibleEnvTemplate = await Bun.file(
  "deploy/dev/ansible/roles/burble-app/templates/env.j2"
).text();
const appDockerfile = await Bun.file("Dockerfile").text();

describe("dev deploy config", () => {
  test("runs the Burble Bun app behind Caddy", () => {
    expect(compose).toContain("burble-app:");
    expect(compose).toContain("dockerfile: Dockerfile");
    expect(compose).toContain('"3000"');
    expect(compose).toContain("http://localhost:3000/healthz");
    expect(appDockerfile).toContain("apk add --no-cache docker-cli");
    expect(caddyfile).toContain("reverse_proxy burble-app:3000");
  });

  test("passes Slack and GitHub OAuth settings to the app", () => {
    for (const name of [
      "SLACK_BOT_TOKEN:?SLACK_BOT_TOKEN is required",
      "SLACK_APP_TOKEN:?SLACK_APP_TOKEN is required",
      "SLACK_LOG_LEVEL",
      "AGENT_MODE",
      "AGENT_RUNTIME",
      "AGENT_RUNTIME_FACTORY",
      "AGENT_RUNTIME_DATA_ROOT",
      "AGENT_RUNTIME_IMAGE",
      "AGENT_RUNTIME_DOCKER_NETWORK",
      "AGENT_RUNTIME_TOKEN_SECRET",
      "AGENT_RUNTIME_TOOL_GATEWAY_URL",
      "AI_MODEL",
      "OPENCLAW_NEMOCLAW_URL",
      "OPENCLAW_CONFIG_PATCH_HOST_PATH",
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
    expect(openClawCompose).toContain("AGENT_RUNTIME_FACTORY=static");
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
    expect(openClawCompose).toContain("OPENCLAW_STATE_DIR=${OPENCLAW_STATE_DIR:-/data/openclaw/state}");
    expect(openClawCompose).toContain(
      "OPENCLAW_CONFIG_PATH=${OPENCLAW_CONFIG_PATH:-/data/openclaw/config/openclaw.json}"
    );
    expect(openClawCompose).toContain(
      "OPENCLAW_WORKSPACE_DIR=${OPENCLAW_WORKSPACE_DIR:-/data/openclaw/workspace}"
    );
    expect(openClawCompose).toContain(
      "OPENCLAW_SETUP_ON_START=${OPENCLAW_SETUP_ON_START:-true}"
    );
    expect(openClawCompose).toContain(
      "OPENCLAW_CONFIG_PATCH_PATH=${OPENCLAW_CONFIG_PATCH_PATH:-}"
    );
    expect(openClawCompose).toContain(
      "OPENCLAW_VALIDATE_ON_START=${OPENCLAW_VALIDATE_ON_START:-true}"
    );
    expect(openClawCompose).toContain("OPENAI_API_KEY=${OPENAI_API_KEY:-}");
    expect(openClawCompose).toContain("ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY:-}");
    expect(openClawCompose).toContain("./openclaw-patches:/etc/openclaw/patches:ro");
  });

  test("provides a no-secrets OpenClaw OpenAI config patch", () => {
    expect(openClawOpenAiPatch).toContain('primary: "openai/gpt-5.5"');
    expect(openClawOpenAiPatch).toContain("openai:default");
    expect(openClawOpenAiPatch).not.toContain("sk-");
    expect(openClawOpenAiPatch).not.toContain("apiKey");
  });

  test("templates OpenClaw/NemoClaw settings for Ansible deploys", () => {
    for (const name of [
      "OPENCLAW_NEMOCLAW_IMAGE",
      "OPENCLAW_NEMOCLAW_ENGINE",
      "OPENCLAW_COMMAND",
      "OPENCLAW_AGENT",
      "OPENCLAW_TIMEOUT_MS",
      "OPENCLAW_STATE_DIR",
      "OPENCLAW_CONFIG_PATH",
      "OPENCLAW_WORKSPACE_DIR",
      "OPENCLAW_SETUP_ON_START",
      "OPENCLAW_CONFIG_PATCH_PATH",
      "OPENCLAW_VALIDATE_ON_START",
      "OPENCLAW_VERSION",
      "AGENT_RUNTIME_FACTORY",
      "AGENT_RUNTIME_DATA_ROOT",
      "AGENT_RUNTIME_IMAGE",
      "AGENT_RUNTIME_DOCKER_NETWORK",
      "AGENT_RUNTIME_TOKEN_SECRET",
      "AGENT_RUNTIME_TOOL_GATEWAY_URL",
      "OPENCLAW_CONFIG_PATCH_HOST_PATH"
    ]) {
      expect(ansibleEnvTemplate).toContain(name);
    }
  });

  test("provides an optional personal runtime compose override", () => {
    expect(personalRuntimesCompose).toContain("AGENT_RUNTIME_FACTORY=docker");
    expect(personalRuntimesCompose).toContain("/var/run/docker.sock");
    expect(personalRuntimesCompose).toContain(
      "AGENT_RUNTIME_TOKEN_SECRET:?AGENT_RUNTIME_TOKEN_SECRET is required"
    );
    expect(personalRuntimesCompose).toContain(
      "burble-openclaw-nemoclaw-openclaw-cli:dev"
    );
    expect(personalRuntimesCompose).toContain("openclaw-nemoclaw-image:");
    expect(personalRuntimesCompose).toContain("profiles:");
    expect(personalRuntimesCompose).toContain("dockerfile: Dockerfile.openclaw-cli");
    expect(personalRuntimesCompose).toContain(
      "AGENT_RUNTIME_DATA_ROOT:-/opt/burble/runtimes"
    );
  });

  test("provides an optional OpenClaw CLI runtime build override", async () => {
    const dockerfile = await Bun.file(
      "runtimes/openclaw-nemoclaw/Dockerfile.openclaw-cli"
    ).text();

    expect(openClawCliCompose).toContain("dockerfile: Dockerfile.openclaw-cli");
    expect(openClawCliCompose).toContain("OPENCLAW_VERSION");
    expect(openClawCliCompose).toContain("OPENCLAW_NEMOCLAW_ENGINE=openclaw");
    expect(openClawCliCompose).toContain(
      "burble-openclaw-nemoclaw-openclaw-cli:dev"
    );
    expect(dockerfile).toContain("FROM node:22.19-bookworm-slim");
    expect(dockerfile).not.toContain("python");
    expect(dockerfile).toContain("npm install -g bun");
    expect(dockerfile).toContain("npm install -g \"openclaw@${OPENCLAW_VERSION}\"");
    expect(dockerfile).toContain("command -v bun");
    expect(dockerfile).toContain("command -v openclaw");
  });
});
