import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import YAML from "yaml";

const chartPath = "deploy/k8s/chart";
const externalValuesPath = `${chartPath}/ci/external-values.yaml`;

describe("Helm release contract", () => {
  test("renders external inference and MCP gateway modes without bundled workloads", async () => {
    const result = Bun.spawnSync([
      "helm",
      "template",
      "burble-release-test",
      chartPath,
      "--values",
      externalValuesPath
    ]);
    expect(result.exitCode, result.stderr.toString()).toBe(0);

    const resources = result.stdout
      .toString()
      .split(/^---\s*$/m)
      .map((document) => YAML.parse(document) as KubernetesResource | null)
      .filter((resource): resource is KubernetesResource => Boolean(resource?.kind));
    const components = resources
      .map((resource) => resource.metadata?.labels?.["app.kubernetes.io/component"])
      .filter(Boolean);

    expect(components).not.toContain("litellm");
    expect(components).not.toContain("agentgateway");
    expect(
      resources.filter((resource) => resource.kind === "Deployment")
    ).toHaveLength(1);

    const envConfig = resources.find(
      (resource) =>
        resource.kind === "ConfigMap" && resource.metadata?.name?.endsWith("-env")
    );
    expect(envConfig?.data?.BURBLE_INFERENCE_BASE_URL).toBe(
      "https://inference.example.invalid/v1"
    );
    expect(envConfig?.data?.AGENT_RUNTIME_MCP_GATEWAY_URL).toBe(
      "https://mcp.example.invalid/mcp"
    );
    expect(envConfig?.data?.AGENT_RUNTIME_MCP_AUDIENCE).toBe(
      "https://mcp.example.invalid/mcp"
    );
  });

  test("documents the dedicated external LiteLLM credential", async () => {
    const [readme, consumerRunbook, integrationContract] = await Promise.all([
      readFile("deploy/k8s/README.md", "utf8"),
      readFile("deploy/k8s/CONSUMER.md", "utf8"),
      readFile("deploy/k8s/INTEGRATION.md", "utf8")
    ]);

    for (const document of [readme, consumerRunbook, integrationContract]) {
      expect(document).toContain("BURBLE_INFERENCE_API_KEY");
    }
    expect(consumerRunbook.replace(/\s+/g, " ")).toContain(
      "credential Burble sends to an external LiteLLM endpoint"
    );
  });
});

type KubernetesResource = {
  kind?: string;
  metadata?: {
    name?: string;
    labels?: Record<string, string>;
  };
  data?: Record<string, string>;
};
