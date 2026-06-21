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
const openShellCompose = await Bun.file(
  "deploy/dev/compose/docker-compose.openshell.yml"
).text();
const openShellGatewayConfig = await Bun.file(
  "deploy/dev/compose/openshell/gateway.toml"
).text();
const agentGatewayConfig = await Bun.file(
  "deploy/dev/compose/agentgateway/config.yaml"
).text();
const personalRuntimeDeployScript = await Bun.file(
  "deploy/dev/compose/deploy-personal-runtimes.sh"
).text();
const rootEnvExample = await Bun.file(".env.example").text();
const composeEnvExample = await Bun.file("deploy/dev/compose/.env.example").text();
const caddyfile = await Bun.file("deploy/dev/compose/Caddyfile").text();
const openClawOpenAiPatch = await Bun.file(
  "deploy/dev/compose/openclaw-patches/openai.json5"
).text();
const ansibleEnvTemplate = await Bun.file(
  "deploy/dev/ansible/roles/burble-app/templates/env.j2"
).text();
const appDockerfile = await Bun.file("Dockerfile").text();
const hermesDockerfile = await Bun.file("runtimes/nemo-hermes/Dockerfile").text();
const burbleNativeDockerfile = await Bun.file(
  "runtimes/burble-native/Dockerfile"
).text();
const openClawRuntimeDockerfile = await Bun.file(
  "runtimes/openclaw-nemoclaw/Dockerfile"
).text();
const openClawCliDockerfile = await Bun.file(
  "runtimes/openclaw-nemoclaw/Dockerfile.openclaw-cli"
).text();
const slackAppManifest = await Bun.file("deploy/dev/slack-app-manifest.yaml").text();
const ciWorkflow = await Bun.file(".github/workflows/ci.yml").text();

describe("dev deploy config", () => {
  test("runs the Burble Bun app behind Caddy", () => {
    expect(compose).toContain("burble-app:");
    expect(compose).toContain("dockerfile: Dockerfile");
    expect(compose).toContain('"3000"');
    expect(compose).toContain("http://localhost:3000/healthz");
    expect(appDockerfile).toContain("apk add --no-cache docker-cli");
    expect(appDockerfile).toContain(
      "COPY packages/runtime-sdk/package.json ./packages/runtime-sdk/package.json"
    );
    expect(appDockerfile).toContain("COPY packages/runtime-sdk ./packages/runtime-sdk");
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
      "AGENT_FAST_TRACK",
      "AGENT_RUNTIME",
      "AGENT_RUNTIME_FACTORY",
      "AGENT_RUNTIME_DATA_ROOT",
      "AGENT_RUNTIME_IMAGE",
      "AGENT_RUNTIME_DOCKER_NETWORK",
      "AGENT_RUNTIME_IDLE_TTL_MS",
      "AGENT_RUNTIME_REAPER_ENABLED",
      "AGENT_RUNTIME_REAPER_INTERVAL_MS",
      "AGENT_RUNTIME_JWT_TTL_SECONDS",
      "AGENT_RUNTIME_TOKEN_SECRET",
      "AGENT_RUNTIME_TOOL_GATEWAY_URL",
      "AGENT_RUNTIME_MCP_GATEWAY_URL",
      "AGENT_RUNTIME_MCP_AUDIENCE",
      "AGENT_RUNTIME_SANDBOX_URL",
      "AGENT_RUNTIME_SANDBOX_TOKEN",
      "AGENT_RUNTIME_SANDBOX_TRANSPORT",
      "AGENT_RUNTIME_SANDBOX_START_COMMAND",
      "AGENT_RUNTIME_OPENSHELL_DIAL_HOST",
      "AGENT_RUNTIME_CONFIG_PATCH_HOST_PATH",
      "ATLASSIAN_MCP_URL",
      "RUNTIME_JWT_ISSUER",
      "RUNTIME_JWT_PRIVATE_KEY_PATH",
      "OBSERVABILITY_JSONL_PATH",
      "OBSERVABILITY_INCLUDE_CONTENT",
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
    expect(slackAppManifest).toContain("app_home:");
    expect(slackAppManifest).toContain("home_tab_enabled: true");
    expect(slackAppManifest).toContain("app_home_opened");
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

  test("passes metadata-only observability settings to the app", () => {
    expect(compose).toContain(
      "OBSERVABILITY_JSONL_PATH=${OBSERVABILITY_JSONL_PATH:-}"
    );
    expect(compose).toContain(
      "OBSERVABILITY_JSONL_DIR=${OBSERVABILITY_JSONL_DIR:-/data/observability/events}"
    );
    expect(compose).toContain(
      "OBSERVABILITY_INCLUDE_CONTENT=${OBSERVABILITY_INCLUDE_CONTENT:-false}"
    );
    expect(ansibleEnvTemplate).toContain(
      "OBSERVABILITY_JSONL_PATH={{ observability_jsonl_path | default('') }}"
    );
    expect(ansibleEnvTemplate).toContain(
      "OBSERVABILITY_JSONL_DIR={{ observability_jsonl_dir | default('/data/observability/events') }}"
    );
    expect(ansibleEnvTemplate).toContain(
      "OBSERVABILITY_INCLUDE_CONTENT={{ observability_include_content | default('false') }}"
    );
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
    expect(openClawCompose).toContain("AGENT_RUNTIME=burble-runtime");
    expect(openClawCompose).toContain("AGENT_FAST_TRACK=${AGENT_FAST_TRACK:-false}");
    expect(openClawCompose).toContain("AGENT_RUNTIME_FACTORY=static");
    expect(openClawCompose).toContain(
      "OPENCLAW_NEMOCLAW_URL=http://openclaw-nemoclaw:8080"
    );
    expect(openClawCompose).toContain(
      "AGENT_RUNTIME_ENGINE=${AGENT_RUNTIME_ENGINE:-}"
    );
    expect(openClawCompose).toContain("context: ../../..");
    expect(openClawCompose).toContain(
      "dockerfile: runtimes/openclaw-nemoclaw/Dockerfile"
    );
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
      "OPENCLAW_FAST_MODE=${OPENCLAW_FAST_MODE:-false}"
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
      "AGENT_RUNTIME_ENGINE",
      "AGENT_FAST_TRACK",
      "AGENT_RUNTIME_DOCKER_NETWORK",
      "AGENT_RUNTIME_IDLE_TTL_MS",
      "AGENT_RUNTIME_REAPER_ENABLED",
      "AGENT_RUNTIME_REAPER_INTERVAL_MS",
      "AGENT_RUNTIME_JWT_TTL_SECONDS",
      "AGENT_RUNTIME_TOKEN_SECRET",
      "AGENT_RUNTIME_TOOL_GATEWAY_URL",
      "AGENT_RUNTIME_MCP_GATEWAY_URL",
      "AGENT_RUNTIME_MCP_AUDIENCE",
      "AGENT_RUNTIME_SANDBOX_URL",
      "AGENT_RUNTIME_SANDBOX_TOKEN",
      "AGENT_RUNTIME_SANDBOX_TRANSPORT",
      "AGENT_RUNTIME_SANDBOX_START_COMMAND",
      "AGENT_RUNTIME_OPENSHELL_DIAL_HOST",
      "AGENT_RUNTIME_CONFIG_PATCH_HOST_PATH",
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
    expect(personalRuntimesCompose).toContain(
      "AGENT_FAST_TRACK=${AGENT_FAST_TRACK:-false}"
    );
    expect(personalRuntimesCompose).toContain("/var/run/docker.sock");
    expect(personalRuntimesCompose).toContain(
      "AGENT_RUNTIME_TOKEN_SECRET:?AGENT_RUNTIME_TOKEN_SECRET is required"
    );
    expect(personalRuntimesCompose).toContain(
      "burble-openclaw-nemoclaw-openclaw-cli:dev"
    );
    expect(personalRuntimesCompose).toContain(
      "AGENT_RUNTIME_IMAGE=${AGENT_RUNTIME_IMAGE:-}"
    );
    expect(personalRuntimesCompose).toContain(
      "AGENT_RUNTIME_ENGINE=${AGENT_RUNTIME_ENGINE:-}"
    );
    expect(personalRuntimesCompose).toContain("openclaw-nemoclaw-image:");
    expect(personalRuntimesCompose).toContain("nemo-hermes-image:");
    expect(personalRuntimesCompose).toContain("burble-native-image:");
    expect(personalRuntimesCompose).toContain("profiles:");
    expect(personalRuntimesCompose).toContain(
      "dockerfile: runtimes/openclaw-nemoclaw/Dockerfile.openclaw-cli"
    );
    expect(personalRuntimesCompose).toContain("context: ../../..");
    expect(personalRuntimesCompose).toContain(
      "dockerfile: runtimes/nemo-hermes/Dockerfile"
    );
    expect(personalRuntimesCompose).toContain("burble-nemo-hermes:dev");
    expect(hermesDockerfile).toContain(
      "COPY runtimes/nemo-hermes/runtime/burble_runtime_contract.py /runtime/burble_runtime_contract.py"
    );
    expect(hermesDockerfile).toContain(
      "COPY runtimes/nemo-hermes/runtime/provider-tool-hints.json /runtime/provider-tool-hints.json"
    );
    expect(hermesDockerfile).toContain(
      "COPY packages/runtime-sdk/schema/runtime-contract.schema.json /runtime/runtime-contract.schema.json"
    );
    expect(ciWorkflow).toContain(
      [
        "docker build \\",
        "            -t burble-nemo-hermes:dev \\",
        "            -f runtimes/nemo-hermes/Dockerfile \\",
        "            ."
      ].join("\n")
    );
    expect(ciWorkflow).toContain('BURBLE_E2E_CONFORMANCE: "1"');
    expect(personalRuntimesCompose).toContain("burble-native-runtime:dev");
    expect(personalRuntimesCompose).toContain(
      "dockerfile: runtimes/burble-native/Dockerfile"
    );
    expect(personalRuntimesCompose).toContain(
      "AGENT_RUNTIME_DATA_ROOT:-/opt/burble/runtimes"
    );
    expect(personalRuntimesCompose).toContain("AGENT_RUNTIME_IDLE_TTL_MS");
    expect(personalRuntimesCompose).toContain("AGENT_RUNTIME_REAPER_ENABLED");
    expect(personalRuntimesCompose).toContain("AGENT_RUNTIME_REAPER_INTERVAL_MS");
    expect(personalRuntimesCompose).toContain("AGENT_RUNTIME_JWT_TTL_SECONDS");
    expect(personalRuntimesCompose).toContain(
      "AGENT_RUNTIME_MCP_GATEWAY_URL:-http://burble-app:3000/mcp"
    );
    expect(personalRuntimesCompose).toContain("AGENT_RUNTIME_MCP_GATEWAY_URL");
    expect(personalRuntimesCompose).toContain("AGENT_RUNTIME_MCP_AUDIENCE");
    expect(personalRuntimesCompose).toContain(
      "AGENT_RUNTIME_CONFIG_PATCH_HOST_PATH=${AGENT_RUNTIME_CONFIG_PATCH_HOST_PATH:-${OPENCLAW_CONFIG_PATCH_HOST_PATH:-}}"
    );
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
    expect(personalRuntimesCompose).toContain("OPENCLAW_FAST_MODE");
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

  test("provides an optional OpenShell sandbox provider override", () => {
    expect(openShellCompose).toContain("openshell:");
    expect(openShellCompose).toContain(
      "ghcr.io/nvidia/openshell/gateway:${OPENSHELL_IMAGE_TAG:-latest}"
    );
    expect(openShellCompose).toContain(
      "${OPENSHELL_BIND_HOST:-0.0.0.0}:${OPENSHELL_PORT:-8080}:8080"
    );
    expect(openShellCompose).toContain(
      "OPENSHELL_GATEWAY_CONFIG=/etc/openshell/gateway.toml"
    );
    expect(openShellCompose).toContain(
      "OPENSHELL_DB_URL=sqlite:/var/lib/openshell/gateway.db?mode=rwc"
    );
    expect(openShellCompose).toContain("XDG_DATA_HOME=/var/lib/openshell");
    expect(openShellCompose).toContain("/var/run/docker.sock:/var/run/docker.sock");
    expect(openShellCompose).toContain(
      "${OPENSHELL_DATA_ROOT:-/var/lib/openshell}:/var/lib/openshell"
    );
    expect(openShellCompose).toContain(
      "./openshell/gateway.toml:/etc/openshell/gateway.toml:ro"
    );
    expect(openShellCompose).toContain("host.openshell.internal:host-gateway");
    expect(openShellCompose).toContain("burble-app:");
    expect(openShellCompose).toContain("AGENT_RUNTIME_FACTORY=sandbox");
    expect(openShellCompose).toContain("AGENT_RUNTIME_SANDBOX_TRANSPORT=grpc");
    expect(openShellCompose).toContain(
      "AGENT_RUNTIME_SANDBOX_URL=http://openshell:8080"
    );
    expect(openShellCompose).toContain(
      "AGENT_RUNTIME_SANDBOX_TOKEN=${AGENT_RUNTIME_SANDBOX_TOKEN:-}"
    );
    expect(openShellCompose).toContain(
      "AGENT_RUNTIME_OPENSHELL_DIAL_HOST=${AGENT_RUNTIME_OPENSHELL_DIAL_HOST:-openshell}"
    );
    expect(openShellGatewayConfig).toContain('compute_drivers     = ["docker"]');
    expect(openShellGatewayConfig).toContain("disable_tls         = true");
    expect(openShellGatewayConfig).toContain("[openshell.gateway.gateway_jwt]");
    expect(openShellGatewayConfig).toContain(
      'signing_key_path = "/var/lib/openshell/jwt/signing.pem"'
    );
    expect(openShellGatewayConfig).toContain("allow_unauthenticated_users = true");
    expect(openShellGatewayConfig).toContain(
      'grpc_endpoint     = "http://172.17.0.1:8080"'
    );
  });

  test("provides a personal runtime deployment helper", () => {
    expect(personalRuntimeDeployScript).toContain("git pull --ff-only");
    expect(personalRuntimeDeployScript).toContain("runtime_build_images=()");
    expect(personalRuntimeDeployScript).toContain("runtime_build_services=()");
    expect(personalRuntimeDeployScript).toContain("dotenv_value()");
    expect(personalRuntimeDeployScript).toContain(
      "runtime_factory=\"$(configured_value AGENT_RUNTIME_FACTORY docker)\""
    );
    expect(personalRuntimeDeployScript).toContain(
      "if [[ \"${runtime_factory}\" != \"sandbox\" ]]"
    );
    expect(personalRuntimeDeployScript).toContain(
      "runtime_engine=\"$(configured_value AGENT_RUNTIME_ENGINE openclaw)\""
    );
    expect(personalRuntimeDeployScript).toContain(
      "configured_runtime_image=\"$(configured_value AGENT_RUNTIME_IMAGE)\""
    );
    expect(personalRuntimeDeployScript).toContain("image_compose_files=(");
    expect(personalRuntimeDeployScript).toContain("app_compose_files=(");
    expect(personalRuntimeDeployScript).toContain("selected_runtime_image_service=\"openclaw-nemoclaw-image\"");
    expect(personalRuntimeDeployScript).toContain("selected_runtime_image_service=\"nemo-hermes-image\"");
    expect(personalRuntimeDeployScript).toContain("selected_runtime_image_service=\"burble-native-image\"");
    expect(personalRuntimeDeployScript).toContain("custom_runtime_image=true");
    expect(personalRuntimeDeployScript).toContain(
      "add_runtime_image_build \"openclaw\" \"burble-openclaw-nemoclaw-openclaw-cli:dev\" \"openclaw-nemoclaw-image\""
    );
    expect(personalRuntimeDeployScript).toContain(
      "add_runtime_image_build \"hermes\" \"burble-nemo-hermes:dev\" \"nemo-hermes-image\""
    );
    expect(personalRuntimeDeployScript).toContain(
      "add_runtime_image_build \"burble-native\" \"burble-native-runtime:dev\" \"burble-native-image\""
    );
    expect(personalRuntimeDeployScript).toContain(
      "AGENT_RUNTIME_IMAGE=\"${runtime_build_images[$i]}\" docker compose"
    );
    expect(personalRuntimeDeployScript).toContain(
      "docker compose \"${app_compose_files[@]}\" up -d --build"
    );
    expect(personalRuntimeDeployScript).toContain("--profile runtime-image build \"${runtime_build_services[$i]}\"");
    expect(personalRuntimeDeployScript).toContain("AGENT_RUNTIME_ENGINE=hermes");
    expect(personalRuntimeDeployScript).toContain("burble-nemo-hermes:dev");
    expect(personalRuntimeDeployScript).toContain("AGENT_RUNTIME_ENGINE=burble-native");
    expect(personalRuntimeDeployScript).toContain("burble-native-runtime:dev");
    expect(personalRuntimeDeployScript).toContain("docker-compose.personal-runtimes.yml");
    expect(personalRuntimeDeployScript).toContain("--agentgateway");
    expect(personalRuntimeDeployScript).toContain("--openshell");
    expect(personalRuntimeDeployScript).toContain(
      "export AGENT_RUNTIME_FACTORY=sandbox"
    );
    expect(personalRuntimeDeployScript).toContain("ensure_openshell_jwt_keys()");
    expect(personalRuntimeDeployScript).toContain("openssl genpkey -algorithm Ed25519");
    expect(personalRuntimeDeployScript).toContain("docker-compose.agentgateway.yml");
    expect(personalRuntimeDeployScript).toContain("docker-compose.openshell.yml");
    expect(personalRuntimeDeployScript).toContain("up -d --build");
    expect(personalRuntimeDeployScript).toContain(
      "up -d --force-recreate --no-deps agentgateway"
    );
    expect(personalRuntimeDeployScript).toContain("image_id()");
    expect(personalRuntimeDeployScript).toContain("previous_runtime_image_id");
    expect(personalRuntimeDeployScript).toContain("current_runtime_image_id");
    expect(personalRuntimeDeployScript).toContain("runtime_image_family()");
    expect(personalRuntimeDeployScript).toContain("container_runtime_engine()");
    expect(personalRuntimeDeployScript).toContain(
      "AGENT_RUNTIME_ENGINE\" { print $2; exit }"
    );
    expect(personalRuntimeDeployScript).toContain(
      "container_image_family=\"$(runtime_image_family \"${container_engine}\")\""
    );
    expect(personalRuntimeDeployScript).toContain(
      '-n "${container_engine}" && "${container_image_family}" == "${runtime_image_family_label}" && "${container_image_id}" != "${current_runtime_image_id}"'
    );
    expect(personalRuntimeDeployScript).toContain(
      "is_known_default_runtime_image()"
    );
    expect(personalRuntimeDeployScript).toContain(
      "select_runtime_image \"burble-nemo-hermes:dev\""
    );
    expect(personalRuntimeDeployScript).toContain(
      "Runtime images unchanged; keeping existing burble-rt-* containers."
    );
    expect(personalRuntimeDeployScript).toContain(
      "Runtime image changed for ${runtime_build_images[$i]}; recycling"
    );
    expect(personalRuntimeDeployScript).toContain("Finished recycling changed runtime images.");
    expect(personalRuntimeDeployScript).toContain("docker ps -aq --filter \"name=burble-rt-\"");
    expect(personalRuntimeDeployScript).toContain("docker inspect --format '{{.Image}}'");
    expect(personalRuntimeDeployScript).toContain("docker stop");
    expect(personalRuntimeDeployScript).toContain("docker rm");
    expect(personalRuntimeDeployScript).toContain("--keep-runtimes");
  });

  test("documents sandbox runtime environment examples", () => {
    for (const envExample of [rootEnvExample, composeEnvExample]) {
      for (const name of [
        "AGENT_RUNTIME_FACTORY",
        "AGENT_RUNTIME_ENGINE",
        "AGENT_RUNTIME_IMAGE",
        "AGENT_RUNTIME_TOKEN_SECRET",
        "AGENT_RUNTIME_MCP_GATEWAY_URL",
        "AGENT_RUNTIME_MCP_AUDIENCE",
        "AGENT_RUNTIME_SANDBOX_URL",
        "AGENT_RUNTIME_SANDBOX_TOKEN",
        "AGENT_RUNTIME_SANDBOX_TRANSPORT",
        "AGENT_RUNTIME_SANDBOX_START_COMMAND",
        "AGENT_RUNTIME_OPENSHELL_DIAL_HOST",
        "OPENSHELL_IMAGE_TAG",
        "OPENSHELL_BIND_HOST",
        "OPENSHELL_PORT",
        "OPENSHELL_HEALTH_PORT",
        "OPENSHELL_DATA_ROOT"
      ]) {
        expect(envExample).toContain(name);
      }
    }
  });

  test("runs selectable runtime images in CI readiness and boots Burble Native", () => {
    expect(ciWorkflow).toContain("Build OpenClaw/NemoClaw CLI runtime image");
    expect(ciWorkflow).toContain("Build Hermes runtime image");
    expect(ciWorkflow).toContain("Build Burble Native runtime image");
    expect(ciWorkflow).toContain(
      "docker build \\\n            -t burble-native-runtime:dev \\\n            -f runtimes/burble-native/Dockerfile \\\n            ."
    );
    expect(ciWorkflow).toContain(
      "BURBLE_E2E_RUNTIME_ENGINES: openclaw,hermes"
    );
    expect(ciWorkflow).toContain("Run Burble Native runtime boot smoke E2E");
    expect(ciWorkflow).toContain('BURBLE_E2E_RUNTIME_BOOT_SMOKE: "1"');
    expect(ciWorkflow).toContain("BURBLE_E2E_RUNTIME_ENGINES: burble-native");
    expect(ciWorkflow).toContain('BURBLE_RUNTIME_CONTRACT_PROBE: "1"');
    expect(ciWorkflow).toContain(
      "BURBLE_E2E_BURBLE_NATIVE_IMAGE: burble-native-runtime:dev"
    );
  });

  test("installs OpenShell network helper dependencies in runtime images", () => {
    expect(hermesDockerfile).toContain("iproute2");
    expect(burbleNativeDockerfile).toContain("apk add --no-cache iproute2");
    expect(openClawRuntimeDockerfile).toContain("apk add --no-cache iproute2");
    expect(openClawCliDockerfile).toContain("iproute2");
  });

  test("provides an optional OpenClaw CLI runtime build override", async () => {
    const dockerfile = await Bun.file(
      "runtimes/openclaw-nemoclaw/Dockerfile.openclaw-cli"
    ).text();

    expect(openClawCliCompose).toContain(
      "dockerfile: runtimes/openclaw-nemoclaw/Dockerfile.openclaw-cli"
    );
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
    expect(dockerfile).toContain("COPY runtimes/openclaw-nemoclaw/skills ./skills");
    expect(dockerfile).toContain(
      "COPY packages/runtime-sdk /runtime/node_modules/@burble/runtime-sdk"
    );
    expect(dockerfile).toContain(
      "RUN cd /runtime/node_modules/@burble/runtime-sdk && bun install --production"
    );
    expect(ciWorkflow).toContain(
      "-f runtimes/openclaw-nemoclaw/Dockerfile.openclaw-cli"
    );
    expect(ciWorkflow).toContain(
      [
        "docker build \\",
        "            -t burble-openclaw-nemoclaw-openclaw-cli:dev \\",
        "            -f runtimes/openclaw-nemoclaw/Dockerfile.openclaw-cli \\",
        "            ."
      ].join("\n")
    );
  });
});
