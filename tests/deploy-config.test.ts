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
const testbedCompose = await Bun.file(
  "deploy/testbed/compose/docker-compose.yml"
).text();
const llmAbCompose = await Bun.file(
  "deploy/testbed/compose/docker-compose.llm-ab.yml"
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
const litellmGatewayConfig = await Bun.file(
  "deploy/dev/compose/litellm/config.yaml"
).text();
const litellmBoundaryLogger = await Bun.file(
  "deploy/dev/compose/litellm/burble_observability.py"
).text();
const agentGatewayConfig = await Bun.file(
  "deploy/dev/compose/agentgateway/config.yaml"
).text();
const personalRuntimeDeployScript = await Bun.file(
  "deploy/dev/compose/deploy-personal-runtimes.sh"
).text();
const rootEnvExample = await Bun.file(".env.example").text();
const composeEnvExample = await Bun.file("deploy/dev/compose/.env.example").text();
const deployReadme = await Bun.file("deploy/dev/README.md").text();
const caddyfile = await Bun.file("deploy/dev/compose/Caddyfile").text();
const openClawOpenAiPatch = await Bun.file(
  "deploy/dev/compose/openclaw-patches/openai.json5"
).text();
const ansibleEnvTemplate = await Bun.file(
  "deploy/dev/ansible/roles/burble-app/templates/env.j2"
).text();
const ansibleGroupVars = await Bun.file(
  "deploy/dev/ansible/group_vars/all.yml"
).text();
const ansibleRoleTasks = await Bun.file(
  "deploy/dev/ansible/roles/burble-app/tasks/main.yml"
).text();
const ansibleRoleHandlers = await Bun.file(
  "deploy/dev/ansible/roles/burble-app/handlers/main.yml"
).text();
const k8sReadme = await Bun.file("deploy/k8s/README.md").text();
const k8sConsumerRunbook = await Bun.file("deploy/k8s/CONSUMER.md").text();
const k8sValues = await Bun.file("deploy/k8s/chart/values.yaml").text();
const k8sHelpers = await Bun.file("deploy/k8s/chart/templates/_helpers.tpl").text();
const k8sConfigMap = await Bun.file(
  "deploy/k8s/chart/templates/configmap.yaml"
).text();
const k8sDeployment = await Bun.file(
  "deploy/k8s/chart/templates/deployment.yaml"
).text();
const k8sService = await Bun.file("deploy/k8s/chart/templates/service.yaml").text();
const k8sNetworkPolicy = await Bun.file(
  "deploy/k8s/chart/templates/networkpolicy.yaml"
).text();
const k8sLiteLlmDeployment = await Bun.file(
  "deploy/k8s/chart/templates/litellm-deployment.yaml"
).text();
const k8sAgentGatewayDeployment = await Bun.file(
  "deploy/k8s/chart/templates/agentgateway-deployment.yaml"
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
    expect(compose).toContain('"3000:3000"');
    expect(compose).toContain("http://localhost:3000/healthz");
    expect(appDockerfile).toContain("apk add --no-cache docker-cli openssh-client");
    expect(appDockerfile).toContain("mkdir -p /data /opt/openshell-cli");
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
      "AGENT_RUNTIME_STREAMING",
      "LLM_GW_BASE_URL",
      "BURBLE_INFERENCE_BASE_URL",
      "AGENT_RUNTIME_SANDBOX_URL",
      "AGENT_RUNTIME_SANDBOX_TOKEN",
      "AGENT_RUNTIME_SANDBOX_TRANSPORT",
      "AGENT_RUNTIME_SANDBOX_START_COMMAND",
      "AGENT_RUNTIME_OPENSHELL_CLI_BIN",
      "AGENT_RUNTIME_OPENSHELL_DIAL_HOST",
      "AGENT_RUNTIME_CONFIG_PATCH_HOST_PATH",
      "ATLASSIAN_MCP_URL",
      "RUNTIME_JWT_ISSUER",
      "RUNTIME_JWT_PRIVATE_KEY_PATH",
      "OBSERVABILITY_JSONL_PATH",
      "OBSERVABILITY_INCLUDE_CONTENT",
      "TASK_WORKFLOW_SHADOW_ENABLED",
      "TASK_WORKFLOW_SHADOW_DATABASE_PATH",
      "TASK_WORKFLOW_AUTHORITY",
      "TASK_WORKFLOW_MAX_ATTEMPTS",
      "SCHEDULED_RUN_AUDIT_RETENTION_DAYS",
      "SCHEDULED_RUN_AUDIT_PRUNE_INTERVAL_MS",
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

  test("runs a neutral LLM gateway service for sandbox inference", () => {
    expect(compose).toContain("llm-gw:");
    expect(compose).toContain("ghcr.io/berriai/litellm:v1.92.0");
    expect(compose).toContain(
      "LLM_GW_BASE_URL=${LLM_GW_BASE_URL:-http://host.openshell.internal:4000/v1}"
    );
    expect(compose).toContain(
      "BURBLE_INFERENCE_BASE_URL=${BURBLE_INFERENCE_BASE_URL:-http://llm-gw:4000/v1}"
    );
    expect(compose).toContain('"4000:4000"');
    expect(compose).toContain("./litellm/config.yaml:/app/config.yaml:ro");
    expect(compose).not.toContain("LITELLM_BASE_URL");
    expect(rootEnvExample).toContain(
      "LLM_GW_BASE_URL=http://host.openshell.internal:4000/v1"
    );
    expect(rootEnvExample).toContain(
      "BURBLE_INFERENCE_BASE_URL=http://llm-gw:4000/v1"
    );
    expect(composeEnvExample).toContain(
      "LLM_GW_BASE_URL=http://host.openshell.internal:4000/v1"
    );
    expect(composeEnvExample).toContain(
      "BURBLE_INFERENCE_BASE_URL=http://llm-gw:4000/v1"
    );
  });

  test("configures the LLM gateway with provider-owned credentials", () => {
    expect(litellmGatewayConfig).toContain("model_name: gpt-5.4");
    expect(litellmGatewayConfig).toContain("model: openai/gpt-5.4");
    expect(litellmGatewayConfig).toContain("model: anthropic/claude-sonnet-4");
    expect(litellmGatewayConfig).toContain("os.environ/OPENAI_API_KEY");
    expect(litellmGatewayConfig).toContain("os.environ/ANTHROPIC_API_KEY");
    expect(litellmGatewayConfig).toContain("os.environ/OLLAMA_API_KEY");
  });

  test("emits redacted LLM boundary telemetry through a custom callback", () => {
    expect(compose).toContain(
      "./litellm/burble_observability.py:/app/burble_observability.py:ro"
    );
    expect(litellmGatewayConfig).toContain("callbacks:");
    expect(litellmGatewayConfig).toContain(
      "burble_observability.boundary_logger"
    );
    expect(litellmBoundaryLogger).toContain("turn_off_message_logging=True");
    expect(litellmBoundaryLogger).not.toContain("print(kwargs)");
    expect(litellmBoundaryLogger).not.toContain("print(data)");
    expect(litellmBoundaryLogger).not.toContain('event["traceback"]');
  });

  test("documents the required Slack slash commands in the app manifest", () => {
    for (const command of [
      "/auth",
      "/help",
      "/tasks",
      "/jobs",
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

  test("passes workflow and scheduled-run audit settings to the app", () => {
    for (const entry of [
      "TASK_WORKFLOW_SHADOW_ENABLED=${TASK_WORKFLOW_SHADOW_ENABLED:-false}",
      "TASK_WORKFLOW_SHADOW_DATABASE_PATH=${TASK_WORKFLOW_SHADOW_DATABASE_PATH:-}",
      "TASK_WORKFLOW_AUTHORITY=${TASK_WORKFLOW_AUTHORITY:-off}",
      "TASK_WORKFLOW_MAX_ATTEMPTS=${TASK_WORKFLOW_MAX_ATTEMPTS:-2}",
      "SCHEDULED_RUN_AUDIT_RETENTION_DAYS=${SCHEDULED_RUN_AUDIT_RETENTION_DAYS:-90}",
      "SCHEDULED_RUN_AUDIT_PRUNE_INTERVAL_MS=${SCHEDULED_RUN_AUDIT_PRUNE_INTERVAL_MS:-86400000}",
    ]) {
      expect(compose).toContain(entry);
    }
    for (const entry of [
      "TASK_WORKFLOW_SHADOW_ENABLED={{ task_workflow_shadow_enabled | default('false') }}",
      "TASK_WORKFLOW_SHADOW_DATABASE_PATH={{ task_workflow_shadow_database_path | default('') }}",
      "TASK_WORKFLOW_AUTHORITY={{ task_workflow_authority | default('off') }}",
      "TASK_WORKFLOW_MAX_ATTEMPTS={{ task_workflow_max_attempts | default('2') }}",
      "SCHEDULED_RUN_AUDIT_RETENTION_DAYS={{ scheduled_run_audit_retention_days | default('90') }}",
      "SCHEDULED_RUN_AUDIT_PRUNE_INTERVAL_MS={{ scheduled_run_audit_prune_interval_ms | default('86400000') }}",
    ]) {
      expect(ansibleEnvTemplate).toContain(entry);
    }
    for (const entry of [
      "TASK_WORKFLOW_SHADOW_ENABLED=false",
      "TASK_WORKFLOW_SHADOW_DATABASE_PATH=",
      "TASK_WORKFLOW_AUTHORITY=off",
      "TASK_WORKFLOW_MAX_ATTEMPTS=2",
      "SCHEDULED_RUN_AUDIT_RETENTION_DAYS=90",
      "SCHEDULED_RUN_AUDIT_PRUNE_INTERVAL_MS=86400000",
    ]) {
      expect(rootEnvExample).toContain(entry);
      expect(composeEnvExample).toContain(entry);
    }
    expect(deployReadme).toContain("TASK_WORKFLOW_AUTHORITY=off");
    expect(deployReadme).toContain("retention defaults to 90 days");
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
      "OPENCLAW_MODEL_API=${OPENCLAW_MODEL_API:-openai-responses}"
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
      "BURBLE_INFERENCE_BASE_URL",
      "LLM_GW_BASE_URL",
      "AGENT_RUNTIME_STREAMING",
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
    for (const name of [
      "agent_runtime_factory: static",
      "agent_runtime_streaming: native",
      "llm_gw_base_url: http://host.openshell.internal:4000/v1",
      "burble_inference_base_url: http://llm-gw:4000/v1",
      "task_workflow_shadow_enabled: false",
      "task_workflow_authority: off",
      "task_workflow_max_attempts: 2",
      "scheduled_run_audit_retention_days: 90",
      "scheduled_run_audit_prune_interval_ms: 86400000",
      "openclaw_model_api: openai-responses",
    ]) {
      expect(ansibleGroupVars).toContain(name);
    }
  });

  test("preserves the active Docker Compose overlay stack in Ansible deploys", () => {
    expect(ansibleRoleTasks).toContain(
      'com.docker.compose.project.config_files'
    );
    expect(ansibleRoleTasks).toContain("burble_compose_config_files");
    expect(ansibleRoleTasks).toContain(
      "label=com.docker.compose.service=burble-app"
    );
    expect(ansibleRoleTasks).toContain(
      "label=com.docker.compose.project.working_dir={{ burble_install_path }}/deploy/dev/compose"
    );
    expect(ansibleRoleTasks).toContain("burble_compose_files");
    expect(ansibleRoleTasks).toContain("replace(',', ':')");
    expect(ansibleRoleTasks).toContain("map('basename') | list");
    expect(ansibleRoleTasks).toContain("burble_active_compose_config_files != '<no value>'");
    expect(ansibleRoleTasks).toContain("['docker-compose.yml']");
    expect(ansibleRoleTasks).toContain("files: \"{{ burble_compose_files }}\"");
    expect(ansibleRoleTasks).not.toContain("compose-burble-app-1");
    expect(ansibleRoleHandlers).toContain(
      "files: \"{{ burble_compose_files | default(['docker-compose.yml']) }}\""
    );
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
    expect(personalRuntimesCompose).toContain("OPENCLAW_MODEL_API");
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
      "AGENT_RUNTIME_MCP_GATEWAY_URL=http://host.openshell.internal:3001/mcp"
    );
    expect(agentGatewayCompose).toContain(
      "AGENT_RUNTIME_MCP_AUDIENCE=http://host.openshell.internal:3001/mcp"
    );
    expect(agentGatewayCompose).toContain('"3001:3000"');
    expect(agentGatewayCompose).toContain(
      "RUNTIME_JWT_ISSUER=http://burble-app:3000"
    );
    expect(agentGatewayCompose).toContain(
      "RUNTIME_JWT_PRIVATE_KEY_PATH=/data/runtime-jwt-private.pem"
    );
    expect(agentGatewayConfig).toContain("issuer: http://burble-app:3000");
    expect(agentGatewayConfig).toContain(
      "http://host.openshell.internal:3001/mcp"
    );
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
      "resource: http://host.openshell.internal:3001/mcp"
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
    expect(openShellCompose).toContain("AGENT_RUNTIME_SANDBOX_TRANSPORT=cli");
    expect(openShellCompose).toContain(
      "AGENT_RUNTIME_SANDBOX_URL=http://openshell:8080"
    );
    expect(openShellCompose).toContain(
      "AGENT_RUNTIME_SANDBOX_TOKEN=${AGENT_RUNTIME_SANDBOX_TOKEN:-}"
    );
    expect(openShellCompose).toContain(
      "AGENT_RUNTIME_OPENSHELL_CLI_BIN=${AGENT_RUNTIME_OPENSHELL_CLI_BIN:-/opt/openshell-cli/openshell}"
    );
    expect(openShellCompose).toContain(
      "AGENT_RUNTIME_OPENSHELL_DIAL_HOST=${AGENT_RUNTIME_OPENSHELL_DIAL_HOST:-openshell}"
    );
    expect(openShellCompose).toContain(
      "source: ${OPENSHELL_CLI_BIN_HOST_PATH:-./.cache/openshell-linux}"
    );
    expect(openShellCompose).toContain("target: /opt/openshell-cli/openshell");
    expect(openShellCompose).toContain("create_host_path: false");
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
    expect(personalRuntimeDeployScript).toContain(
      "export AGENT_RUNTIME_TOOL_GATEWAY_URL=http://host.openshell.internal:3000/internal/tools"
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
      "Runtime images unchanged; keeping existing burble-rt-* and openshell-b-* containers."
    );
    expect(personalRuntimeDeployScript).toContain(
      "Runtime image changed for ${runtime_build_images[$i]}; recycling"
    );
    expect(personalRuntimeDeployScript).toContain("Finished recycling changed runtime images.");
    expect(personalRuntimeDeployScript).toContain("docker ps -aq --filter \"name=burble-rt-\"");
    expect(personalRuntimeDeployScript).toContain("docker ps -aq --filter \"name=openshell-b-\"");
    expect(personalRuntimeDeployScript).toContain("runtime_container_candidates()");
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

  test("runs both sandbox agents through real OpenShell in CI", () => {
    expect(ciWorkflow).toContain("OpenShell runtime E2E");
    expect(ciWorkflow).toContain("Start OpenShell testbed");
    expect(ciWorkflow).toContain("bun run testbed:up");
    expect(ciWorkflow).toContain("AGENT_RUNTIME_SANDBOX_TRANSPORT: cli");
    expect(ciWorkflow).toContain("Verify app OpenShell CLI dependencies");
    expect(ciWorkflow).toContain("command -v ssh >/dev/null");
    expect(ciWorkflow).toContain(
      "/opt/openshell-cli/openshell --gateway-endpoint http://openshell:8080 sandbox list"
    );
    expect(ciWorkflow).toContain("Run Hermes through OpenShell");
    expect(ciWorkflow).toContain('BURBLE_E2E_OPENSHELL_RUN: "1"');
    expect(ciWorkflow).toContain("BURBLE_E2E_RUNTIME_ENGINE: hermes");
    expect(ciWorkflow).toContain(
      "AGENT_RUNTIME_SANDBOX_START_COMMAND: '[\"python\",\"/runtime/entrypoint.py\"]'"
    );
    expect(ciWorkflow).toContain("Run OpenClaw through OpenShell");
    expect(ciWorkflow).toContain("BURBLE_E2E_RUNTIME_ENGINE: openclaw");
    expect(ciWorkflow).toContain(
      "AGENT_RUNTIME_SANDBOX_START_COMMAND: '[\"sh\",\"-lc\",\"cd /runtime && exec bun src/index.ts\"]'"
    );
    expect(ciWorkflow).toContain("tests/e2e/openshell-sandbox-runtime.test.ts");
    expect(ciWorkflow).toContain('BURBLE_RUNTIME_CONTRACT_PROBE: "1"');
    expect(ciWorkflow).toContain("Dump OpenShell testbed logs");
    expect(ciWorkflow).toContain('docker ps -aq --filter "name=openshell-b-"');
    expect(ciWorkflow).toContain("bun run testbed:down");
  });

  test("installs OpenShell network helper dependencies in runtime images", () => {
    expect(hermesDockerfile).toContain("iproute2");
    expect(burbleNativeDockerfile).toContain("apk add --no-cache iproute2");
    expect(openClawRuntimeDockerfile).toContain("apk add --no-cache iproute2");
    expect(openClawCliDockerfile).toContain("iproute2");
  });

  test("creates OpenShell-writable runtime data roots in runtime images", () => {
    expect(hermesDockerfile).toContain("/data/openclaw/hermes");
    expect(hermesDockerfile).toContain("chown -R sandbox:sandbox /runtime /data/openclaw");
    expect(openClawRuntimeDockerfile).toContain("/data/openclaw/config");
    expect(openClawRuntimeDockerfile).toContain("/data/openclaw/logs");
    expect(openClawCliDockerfile).toContain("/data/openclaw/config");
    expect(openClawCliDockerfile).toContain("/data/openclaw/logs");
    expect(openClawCliDockerfile).toContain(
      "chown -R root:root /runtime/openclaw-plugins"
    );
    expect(burbleNativeDockerfile).toContain("/data/burble-native/config");
    expect(burbleNativeDockerfile).toContain("/data/burble-native/workspace");
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
      "OPENCLAW_VERSION: ${OPENCLAW_VERSION:-2026.6.11}"
    );
    expect(personalRuntimesCompose).toContain(
      "OPENCLAW_VERSION: ${OPENCLAW_VERSION:-2026.6.11}"
    );
    expect(testbedCompose).toContain(
      "OPENCLAW_VERSION: ${OPENCLAW_VERSION:-2026.6.11}"
    );
    expect(composeEnvExample).toContain("OPENCLAW_VERSION=2026.6.11");
    expect(ansibleGroupVars).toContain('openclaw_version: "2026.6.11"');
    expect(ansibleEnvTemplate).toContain(
      "OPENCLAW_VERSION={{ openclaw_version | default('2026.6.11') }}"
    );
    expect(openClawCliCompose).toContain(
      "OPENCLAW_NEMOCLAW_ENGINE=${OPENCLAW_NEMOCLAW_ENGINE:-openclaw}"
    );
    expect(openClawCliCompose).toContain(
      "burble-openclaw-nemoclaw-openclaw-cli:dev"
    );
    expect(dockerfile).toContain("FROM node:22.19-trixie-slim");
    expect(dockerfile).toContain("ARG OPENCLAW_VERSION=2026.6.11");
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

  test("ships a Kubernetes blueprint with optional LiteLLM and agentgateway modes", () => {
    expect(k8sReadme).toContain("LiteLLM: `managed`, `external`, or `disabled`");
    expect(k8sReadme).toContain("agentgateway: `managed`, `external`, or `disabled`");
    expect(k8sConsumerRunbook).toContain("litellm.mode=external");
    expect(k8sConsumerRunbook).toContain("agentgateway.mode=external");
    expect(k8sValues).toContain("litellm:");
    expect(k8sValues).toContain("mode: disabled");
    expect(k8sValues).toContain("externalBaseUrl");
    expect(k8sValues).toContain("agentgateway:");
    expect(k8sValues).toContain("externalUrl");
    expect(k8sHelpers).toContain("burble.litellm.baseUrl");
    expect(k8sHelpers).toContain("litellm.mode=external");
    expect(k8sHelpers).toContain("burble.agentgateway.url");
    expect(k8sHelpers).toContain("agentgateway.mode=external");
    expect(k8sHelpers).toContain("burble.appSelectorLabels");
    expect(k8sHelpers).toContain("app.kubernetes.io/component: app");
    expect(k8sConfigMap).toContain("LLM_GW_BASE_URL");
    expect(k8sConfigMap).toContain("BURBLE_INFERENCE_BASE_URL");
    expect(k8sConfigMap).toContain("AGENT_RUNTIME_MCP_GATEWAY_URL");
    expect(k8sConfigMap).toContain("AGENT_RUNTIME_MCP_AUDIENCE");
    expect(k8sConfigMap).toContain("TASK_WORKFLOW_AUTHORITY");
    expect(k8sDeployment).toContain("app.kubernetes.io/component: app");
    expect(k8sDeployment).toContain(
      '{{- include "burble.appSelectorLabels" . | nindent 6 }}'
    );
    expect(k8sDeployment).toContain(
      '{{- include "burble.appSelectorLabels" . | nindent 8 }}'
    );
    expect(k8sDeployment).not.toContain(
      '{{- include "burble.selectorLabels" . | nindent 6 }}'
    );
    expect(k8sService).toContain(
      '{{- include "burble.appSelectorLabels" . | nindent 4 }}'
    );
    expect(k8sDeployment).toContain("secretRef:");
    expect(k8sDeployment).toContain("persistentVolumeClaim:");
    expect(k8sLiteLlmDeployment).toContain('eq .Values.litellm.mode "managed"');
    expect(k8sValues).toContain("repository: ghcr.io/berriai/litellm");
    expect(k8sValues).toContain("tag: v1.92.0");
    expect(k8sAgentGatewayDeployment).toContain(
      'eq .Values.agentgateway.mode "managed"'
    );
    expect(k8sValues).toContain("repository: ghcr.io/agentgateway/agentgateway");
    expect(k8sNetworkPolicy).toContain('eq .Values.litellm.mode "managed"');
    expect(k8sNetworkPolicy).toContain(
      'eq .Values.agentgateway.mode "managed"'
    );
    expect(k8sNetworkPolicy).toContain(
      '{{- include "burble.appSelectorLabels" . | nindent 6 }}'
    );
    expect(k8sNetworkPolicy).toContain(
      '{{- include "burble.appSelectorLabels" . | nindent 14 }}'
    );
    expect(k8sNetworkPolicy).not.toContain("ingress: []");
  });
});

describe("local LLM A/B testbed", () => {
  test("keeps direct and LiteLLM runtimes identical except for inference routing", () => {
    expect(llmAbCompose).toContain("name: burble-llm-ab");
    expect(llmAbCompose).toContain("runtime-direct:");
    expect(llmAbCompose).toContain("runtime-litellm:");
    expect(llmAbCompose).toContain("openai-direct:");
    expect(llmAbCompose).toContain("ghcr.io/berriai/litellm:v1.92.0");
    expect(llmAbCompose).toContain("OPENCLAW_MODEL_API: openai-responses");
    expect(llmAbCompose).toContain("AI_MODEL: ${AI_MODEL:-openai:gpt-5.4}");
    expect(llmAbCompose).toContain(
      "AGENT_RUNTIME_INFERENCE_BASE_URL: http://llm-gw:4000/v1"
    );
    expect(llmAbCompose).toContain(
      "AGENT_RUNTIME_INFERENCE_BASE_URL: http://openai-direct:4100/v1"
    );
    expect(llmAbCompose).toContain(
      "OPENAI_API_KEY: sk-BURBLE-INFERENCE-PROXY"
    );
    expect(llmAbCompose.match(/Dockerfile\.openclaw-cli/g)).toHaveLength(1);
    expect(llmAbCompose.match(/build: \*openclaw-build/g)).toHaveLength(1);
    expect(
      llmAbCompose.match(
        /OPENCLAW_VERSION: \$\{OPENCLAW_VERSION:-2026\.6\.11\}/g
      )
    ).toHaveLength(1);
    expect(llmAbCompose).toContain('profiles: ["soak"]');
    expect(llmAbCompose).toContain(
      "LLM_AB_DIRECT_URL: http://runtime-direct:8080"
    );
    expect(llmAbCompose).toContain(
      "LLM_AB_LITELLM_URL: http://runtime-litellm:8080"
    );
    expect(llmAbCompose).not.toContain('"14000:4000"');
    expect(llmAbCompose).toContain('"127.0.0.1:18080:8080"');
    expect(llmAbCompose).toContain('"127.0.0.1:18081:8080"');
  });
});
