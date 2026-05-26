const commonProcessEnvNames = new Set([
  "HOME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "LOGNAME",
  "NODE_EXTRA_CA_CERTS",
  "PATH",
  "SSL_CERT_FILE",
  "TERM",
  "TMPDIR",
  "TZ",
  "USER"
]);

const modelProviderEnvPrefixes = ["OPENAI_", "ANTHROPIC_", "OLLAMA_"];
const proxyEnvNames = new Set([
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy"
]);

const forbiddenEnvPrefixes = [
  "AGENT_RUNTIME_",
  "ATLASSIAN_",
  "BURBLE_",
  "GITHUB_",
  "GOOGLE_",
  "JIRA_",
  "MCP_",
  "RUNTIME_JWT_",
  "SLACK_"
];

const forbiddenEnvPattern =
  /(authorization|cookie|credential|jwt|oauth|password|refresh|secret|token)/i;

export function buildOpenClawProcessEnv(
  overrides: Record<string, string | undefined> = {},
  sourceEnv: Record<string, string | undefined> = Bun.env
): Record<string, string> {
  return {
    ...filterEnv(sourceEnv, isAllowedHostEnv),
    ...filterEnv(overrides, isAllowedOpenClawOverrideEnv)
  };
}

function filterEnv(
  env: Record<string, string | undefined>,
  allow: (name: string) => boolean
): Record<string, string> {
  const entries = Object.entries(env).filter(
    (entry): entry is [string, string] =>
      Boolean(entry[1]) && allow(entry[0])
  );
  return Object.fromEntries(entries);
}

function isAllowedOpenClawOverrideEnv(name: string): boolean {
  return name.startsWith("OPENCLAW_") || isAllowedHostEnv(name);
}

function isAllowedHostEnv(name: string): boolean {
  if (commonProcessEnvNames.has(name) || proxyEnvNames.has(name)) {
    return true;
  }

  if (modelProviderEnvPrefixes.some((prefix) => name.startsWith(prefix))) {
    return true;
  }

  if (forbiddenEnvPrefixes.some((prefix) => name.startsWith(prefix))) {
    return false;
  }

  return !forbiddenEnvPattern.test(name);
}
