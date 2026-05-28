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
const agentGatewayCompose = await Bun.file(
  "deploy/dev/compose/docker-compose.agentgateway.yml"
).text();
const agentGatewayConfig = await Bun.file(
  "deploy/dev/compose/agentgateway/config.yaml"
).text();
const personalRuntimeDeployScript = await Bun.file(
  "deploy/dev/compose/deploy-personal-runtimes.sh"
).text();
const caddyfile = await Bun.file("deploy/dev/compose/Caddyfile").text();
const openClawOpenAiPatch = await Bun.file(
  "deploy/dev/compose/openclaw-patches/openai.json5"
).text();
const ansibleEnvTemplate = await Bun.file(
  "deploy/dev/ansible/roles/burble-app/templates/env.j2"
).text();
const appDockerfile = await Bun.file("Dockerfile").text();
const slackAppManifest = await Bun.file("deploy/dev/slack-app-manifest.yaml").text();

describe("dev deploy config", () => {
  test("runs the Burble Bun app behind Caddy", () => {
    expect(compose).toContain("burble-app:");
    expect(compose).toContain("dockerfile: Dockerfile");
    expect(compose).toContain('"3000"');
    expect(compose).toContain("http://localhost:3000/healthz");
    expect(appDockerfile).toContain("apk add --no-cache docker-cli");
    expect(caddyfile).toContain("reverse_proxy burble-app:3000");
  });

  test("passes Slack, GitHub, and Jira OAuth settings to the app", () => {
    for (const name of [
      "SLACK_BOT_TOKEN:?SLACK_BOT_TOKEN is required",
      "SLACK_APP_TOKEN:?SLACK_APP_TOKEN is required",
      "SLACK_LOG_LEVEL",
      "SLACK_CLIENT_ID",
      "SLACK_CLIENT_SECRET",
      "SLACK_REDIRECT_URI",
      "AGENT_MODE",
      "AGENT_RUNTIME",
      "AGENT_RUNTIME_FACTORY",
      "AGENT_RUNTIME_DATA_ROOT",
      "AGENT_RUNTIME_IMAGE",
      "AGENT_RUNTIME_DOCKER_NETWORK",
      "AGENT_RUNTIME_IDLE_TTL_MS",
      "AGENT_RUNTIME_REAPER_INTERVAL_MS",
      "AGENT_RUNTIME_JWT_TTL_SECONDS",
      "AGENT_RUNTIME_TOKEN_SECRET",
      "AGENT_RUNTIME_TOOL_GATEWAY_URL",
      "AGENT_RUNTIME_MCP_GATEWAY_URL",
      "AGENT_RUNTIME_MCP_AUDIENCE",
      "ATLASSIAN_MCP_URL",
      "RUNTIME_JWT_ISSUER",
      "RUNTIME_JWT_PRIVATE_KEY_PATH",
      "AI_MODEL",
      "OPENCLAW_NEMOCLAW_URL",
      "OPENCLAW_CONFIG_PATCH_HOST_PATH",
      "INTERNAL_API_TOKEN",
      "OPENAI_API_KEY",
      "ANTHROPIC_API_KEY",
      "OLLAMA_API_KEY",
      "OLLAMA_BASE_URL",
      "OLLAMA_OPENAI_BASE_URL",
      "GITHUB_CLIENT_ID:?GITHUB_CLIENT_ID is required",
      "GITHUB_CLIENT_SECRET:?GITHUB_CLIENT_SECRET is required",
      "JIRA_CLIENT_ID",
      "JIRA_CLIENT_SECRET",
      "BASE_URL",
      "DATABASE_PATH"
    ]) {
      expect(compose).toContain(name);
    }
  });

  test("documents the required Slack slash commands in the app manifest", () => {
    for (const command of [
      "/auth",
      "/help",
      "/agent",
      "/agent-status",
      "/agent-config"
    ]) {
      expect(slackAppManifest).toContain(`command: ${command}`);
    }
    expect(slackAppManifest).toContain("socket_mode_enabled: true");
    expect(slackAppManifest).toContain("commands");
    expect(slackAppManifest).toContain("files:read");
    expect(slackAppManifest).not.toContain("/connect-github");
    expect(slackAppManifest).not.toContain("/issues");
    expect(slackAppManifest).not.toContain("/github-me");
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
    expect(caddyfile).toContain("@mcp path /mcp*");
    expect(caddyfile).toContain("respond @mcp 404");
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
    expect(openClawCompose).toContain(
      "OPENCLAW_STREAM_DEBUG=${OPENCLAW_STREAM_DEBUG:-false}"
    );
    expect(openClawCompose).toContain("OPENCLAW_LOG_LEVEL=${OPENCLAW_LOG_LEVEL:-}");
    expect(openClawCompose).toContain(
      "OPENCLAW_DEBUG_MODEL_TRANSPORT=${OPENCLAW_DEBUG_MODEL_TRANSPORT:-}"
    );
    expect(openClawCompose).toContain(
      "OPENCLAW_RAW_STREAM_DEBUG=${OPENCLAW_RAW_STREAM_DEBUG:-false}"
    );
    expect(openClawCompose).toContain(
      "OPENCLAW_GATEWAY_PORT=${OPENCLAW_GATEWAY_PORT:-18789}"
    );
    expect(openClawCompose).toContain(
      "OPENCLAW_GATEWAY_BIND=${OPENCLAW_GATEWAY_BIND:-loopback}"
    );
    expect(openClawCompose).toContain(
      "OPENCLAW_GATEWAY_TOKEN=${OPENCLAW_GATEWAY_TOKEN:-}"
    );
    expect(openClawCompose).toContain("OPENAI_API_KEY=${OPENAI_API_KEY:-}");
    expect(openClawCompose).toContain("ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY:-}");
    expect(openClawCompose).toContain("AI_MODEL=${AI_MODEL:-openai:gpt-5.4}");
    expect(openClawCompose).toContain("OLLAMA_API_KEY=${OLLAMA_API_KEY:-}");
    expect(openClawCompose).toContain(
      "OLLAMA_BASE_URL=${OLLAMA_BASE_URL:-https://ollama.com}"
    );
    expect(openClawCompose).toContain("./openclaw-patches:/etc/openclaw/patches:ro");
  });

  test("provides a no-secrets OpenClaw OpenAI config patch", () => {
    expect(openClawOpenAiPatch).toContain('primary: "openai/gpt-5.4"');
    expect(openClawOpenAiPatch).toContain(
      'file: "/data/openclaw/logs/openclaw.log"'
    );
    expect(openClawOpenAiPatch).toContain('allow: ["openai"]');
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
      "OPENCLAW_STREAM_DEBUG",
      "OPENCLAW_LOG_LEVEL",
      "OPENCLAW_DIAGNOSTICS",
      "OPENCLAW_DEBUG_MODEL_TRANSPORT",
      "OPENCLAW_DEBUG_MODEL_PAYLOAD",
      "OPENCLAW_DEBUG_SSE",
      "OPENCLAW_DEBUG_CODE_MODE",
      "OPENCLAW_RAW_STREAM_DEBUG",
      "OPENCLAW_GATEWAY_PORT",
      "OPENCLAW_GATEWAY_BIND",
      "OPENCLAW_GATEWAY_TOKEN",
      "OPENCLAW_VERSION",
      "OLLAMA_API_KEY",
      "OLLAMA_BASE_URL",
      "OLLAMA_OPENAI_BASE_URL",
      "AGENT_RUNTIME_FACTORY",
      "AGENT_RUNTIME_DATA_ROOT",
      "AGENT_RUNTIME_IMAGE",
      "AGENT_RUNTIME_DOCKER_NETWORK",
      "AGENT_RUNTIME_IDLE_TTL_MS",
      "AGENT_RUNTIME_REAPER_INTERVAL_MS",
      "AGENT_RUNTIME_JWT_TTL_SECONDS",
      "AGENT_RUNTIME_TOKEN_SECRET",
      "AGENT_RUNTIME_TOOL_GATEWAY_URL",
      "AGENT_RUNTIME_MCP_GATEWAY_URL",
      "AGENT_RUNTIME_MCP_AUDIENCE",
      "ATLASSIAN_MCP_URL",
      "RUNTIME_JWT_ISSUER",
      "RUNTIME_JWT_PRIVATE_KEY_PATH",
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
    expect(personalRuntimesCompose).toContain("AGENT_RUNTIME_IDLE_TTL_MS");
    expect(personalRuntimesCompose).toContain("AGENT_RUNTIME_REAPER_INTERVAL_MS");
    expect(personalRuntimesCompose).toContain("AGENT_RUNTIME_JWT_TTL_SECONDS");
    expect(personalRuntimesCompose).toContain(
      "AGENT_RUNTIME_MCP_GATEWAY_URL:-http://burble-app:3000/mcp"
    );
    expect(personalRuntimesCompose).toContain("AGENT_RUNTIME_MCP_GATEWAY_URL");
    expect(personalRuntimesCompose).toContain("AGENT_RUNTIME_MCP_AUDIENCE");
    expect(personalRuntimesCompose).toContain("RUNTIME_JWT_ISSUER");
    expect(personalRuntimesCompose).toContain("RUNTIME_JWT_PRIVATE_KEY_PATH");
    expect(personalRuntimesCompose).toContain(
      "OPENCLAW_NEMOCLAW_ENGINE=${OPENCLAW_NEMOCLAW_ENGINE:-openclaw}"
    );
    expect(personalRuntimesCompose).toContain(
      "OPENCLAW_TIMEOUT_MS=${OPENCLAW_TIMEOUT_MS:-180000}"
    );
    expect(personalRuntimesCompose).toContain("OPENCLAW_STREAM_DEBUG");
    expect(personalRuntimesCompose).toContain("OPENCLAW_LOG_LEVEL");
    expect(personalRuntimesCompose).toContain("OPENCLAW_DEBUG_MODEL_PAYLOAD");
    expect(personalRuntimesCompose).toContain("OPENCLAW_DEBUG_CODE_MODE");
    expect(personalRuntimesCompose).toContain("OPENCLAW_RAW_STREAM_DEBUG");
    expect(personalRuntimesCompose).toContain("OPENCLAW_GATEWAY_PORT");
    expect(personalRuntimesCompose).toContain("OPENCLAW_GATEWAY_BIND");
    expect(personalRuntimesCompose).toContain("OPENCLAW_GATEWAY_TOKEN");
  });

  test("provides an optional agentgateway MCP override", () => {
    expect(agentGatewayCompose).toContain("agentgateway:");
    expect(agentGatewayCompose).toContain(
      "ghcr.io/agentgateway/agentgateway:v1.1.0"
    );
    expect(agentGatewayCompose).toContain("--file");
    expect(agentGatewayCompose).toContain(
      "AGENT_RUNTIME_MCP_GATEWAY_URL=http://agentgateway:3000/mcp"
    );
    expect(agentGatewayCompose).toContain(
      "AGENT_RUNTIME_MCP_AUDIENCE=http://agentgateway:3000/mcp"
    );
    expect(agentGatewayCompose).toContain(
      "RUNTIME_JWT_ISSUER=http://burble-app:3000"
    );
    expect(agentGatewayCompose).toContain(
      "RUNTIME_JWT_PRIVATE_KEY_PATH=/data/runtime-jwt-private.pem"
    );
    expect(agentGatewayConfig).toContain("issuer: http://burble-app:3000");
    expect(agentGatewayConfig).toContain(
      "url: http://burble-app:3000/oauth/jwks"
    );
    expect(agentGatewayConfig).toContain(
      "host: http://burble-app:3000/mcp"
    );
    expect(agentGatewayConfig).toContain("exact: /mcp/github");
    expect(agentGatewayConfig).toContain(
      "host: http://burble-app:3000/mcp/github"
    );
    expect(agentGatewayConfig).toContain("exact: /mcp/jira");
    expect(agentGatewayConfig).toContain("exact: /mcp/slack");
    expect(agentGatewayConfig).toContain("exact: /mcp/atlassian");
    expect(agentGatewayConfig).toContain("backendAuth:");
    expect(agentGatewayConfig).toContain("passthrough: {}");
    expect(agentGatewayConfig).toContain(
      "resource: http://agentgateway:3000/mcp"
    );
  });

  test("provides a personal runtime deployment helper", () => {
    expect(personalRuntimeDeployScript).toContain("git pull --ff-only");
    expect(personalRuntimeDeployScript).toContain("--profile runtime-image build openclaw-nemoclaw-image");
    expect(personalRuntimeDeployScript).toContain("docker-compose.personal-runtimes.yml");
    expect(personalRuntimeDeployScript).toContain("--agentgateway");
    expect(personalRuntimeDeployScript).toContain("docker-compose.agentgateway.yml");
    expect(personalRuntimeDeployScript).toContain("up -d --build");
    expect(personalRuntimeDeployScript).toContain(
      "up -d --force-recreate --no-deps agentgateway"
    );
    expect(personalRuntimeDeployScript).toContain("docker ps -aq --filter \"name=burble-rt-\"");
    expect(personalRuntimeDeployScript).toContain("docker stop");
    expect(personalRuntimeDeployScript).toContain("docker rm");
    expect(personalRuntimeDeployScript).toContain("--keep-runtimes");
  });

  test("provides an optional OpenClaw CLI runtime build override", async () => {
    const dockerfile = await Bun.file(
      "runtimes/openclaw-nemoclaw/Dockerfile.openclaw-cli"
    ).text();

    expect(openClawCliCompose).toContain("dockerfile: Dockerfile.openclaw-cli");
    expect(openClawCliCompose).toContain("OPENCLAW_VERSION");
    expect(openClawCliCompose).toContain(
      "OPENCLAW_NEMOCLAW_ENGINE=${OPENCLAW_NEMOCLAW_ENGINE:-openclaw}"
    );
    expect(openClawCliCompose).toContain(
      "burble-openclaw-nemoclaw-openclaw-cli:dev"
    );
    expect(dockerfile).toContain("FROM node:22.19-bookworm-slim");
    expect(dockerfile).not.toContain("python");
    expect(dockerfile).toContain("npm install -g bun");
    expect(dockerfile).toContain("npm install -g \"openclaw@${OPENCLAW_VERSION}\"");
    expect(dockerfile).toContain("command -v bun");
    expect(dockerfile).toContain("command -v openclaw");
    expect(dockerfile).toContain("COPY skills ./skills");
  });
});
