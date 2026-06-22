import { writeFileSync } from "node:fs";

const ciaoNetworkGuardPath = "/tmp/ciao-network-guard.cjs";

const ciaoNetworkGuardSource = `
const os = require("node:os");
const originalNetworkInterfaces = os.networkInterfaces;
os.networkInterfaces = function guardedNetworkInterfaces() {
  try {
    const interfaces = originalNetworkInterfaces.call(os);
    if (interfaces && Object.keys(interfaces).length > 0) {
      return interfaces;
    }
  } catch {}
  return {
    lo: [{
      address: "127.0.0.1",
      netmask: "255.0.0.0",
      family: "IPv4",
      mac: "00:00:00:00:00:00",
      internal: true,
      cidr: "127.0.0.1/8"
    }]
  };
};
`.trimStart();

const commonProcessEnvNames = new Set([
  "HOME",
  "JITI_FS_CACHE",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "LOGNAME",
  "NODE_EXTRA_CA_CERTS",
  "NODE_OPTIONS",
  "PATH",
  "SSL_CERT_FILE",
  "TERM",
  "TMPDIR",
  "TZ",
  "USER",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "npm_config_cache"
]);

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
  /(api[_-]?key|authorization|cookie|credential|jwt|oauth|password|refresh|secret|token)/i;

export function buildOpenClawProcessEnv(
  overrides: Record<string, string | undefined> = {},
  sourceEnv: Record<string, string | undefined> = Bun.env
): Record<string, string> {
  ensureCiaoNetworkGuard();
  const env = {
    ...filterEnv(sourceEnv, isAllowedHostEnv),
    ...filterEnv(overrides, isAllowedOpenClawOverrideEnv)
  };
  env.NODE_OPTIONS = appendNodeRequire(env.NODE_OPTIONS, ciaoNetworkGuardPath);
  return env;
}

function ensureCiaoNetworkGuard(): void {
  writeFileSync(ciaoNetworkGuardPath, ciaoNetworkGuardSource, { mode: 0o644 });
}

function appendNodeRequire(value: string | undefined, path: string): string {
  const required = `--require ${path}`;
  if (!value?.trim()) {
    return required;
  }
  return value.includes(required) ? value : `${value} ${required}`;
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
  return (
    (name.startsWith("OPENCLAW_") && !forbiddenEnvPattern.test(name)) ||
    isAllowedHostEnv(name)
  );
}

function isAllowedHostEnv(name: string): boolean {
  if (commonProcessEnvNames.has(name) || proxyEnvNames.has(name)) {
    return true;
  }

  if (forbiddenEnvPrefixes.some((prefix) => name.startsWith(prefix))) {
    return false;
  }

  return !forbiddenEnvPattern.test(name);
}
