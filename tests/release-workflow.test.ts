import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

const workflowPath = ".github/workflows/release.yml";

describe("immutable release workflow", () => {
  test("publishes signed image and chart digests through OIDC-configured ECR", async () => {
    const workflow = await readFile(workflowPath, "utf8");

    expect(workflow).toContain("id-token: write");
    expect(workflow).toContain("aws-actions/configure-aws-credentials@");
    expect(workflow).toContain("role-to-assume: ${{ vars.AWS_RELEASE_ROLE_ARN }}");
    expect(workflow).toContain("aws-region: ${{ vars.AWS_REGION }}");
    expect(workflow).toContain("ECR_REGISTRY: ${{ vars.ECR_REGISTRY }}");
    expect(workflow).toContain(
      "BURBLE_ECR_IMAGE_REPOSITORY: ${{ vars.BURBLE_ECR_IMAGE_REPOSITORY }}"
    );
    expect(workflow).toContain(
      "BURBLE_ECR_CHART_REPOSITORY: ${{ vars.BURBLE_ECR_CHART_REPOSITORY }}"
    );
    expect(workflow).not.toContain("secrets.AWS_");
    expect(workflow).not.toContain("secrets.ECR_");

    expect(workflow).toContain("platforms: linux/amd64");
    expect(workflow).toContain("push: true");
    expect(workflow).toContain("provenance: mode=max");
    expect(workflow).toContain("sbom: true");
    expect(workflow).toContain("imagetools inspect");
    expect(workflow).toContain("image-platform.digest");
    expect(workflow).toContain("wait-for-ecr-scan.ts");
    expect(workflow).toContain("cosign sign --yes");
    expect(workflow).toContain("cosign attest --yes --type spdxjson");
    expect(workflow).toContain("cosign attest --yes --type vuln");
    expect(workflow.match(/attest-build-provenance@/g)).toHaveLength(2);

    expect(workflow).toContain("helm package deploy/k8s/chart");
    expect(workflow).toContain("--app-version \"$VERSION\"");
    expect(workflow).toContain("helm push");
    expect(workflow).toContain("image.digest");
    expect(workflow).toContain("chart.digest");
    expect(workflow).toContain("generate-release-report.ts");
    expect(workflow).toContain("gh release create");
  });

  test("keeps environment-specific deployment values out of release sources", async () => {
    const paths = [
      workflowPath,
      "deploy/k8s/chart/values.yaml",
      "deploy/k8s/chart/ci/external-values.yaml",
      "docs/releases.md"
    ];
    const content = (await Promise.all(paths.map((path) => readFile(path, "utf8")))).join(
      "\n"
    );

    expect(content).not.toMatch(/arn:aws:/i);
    expect(content).not.toMatch(/\.nip\.io\b/i);
    expect(content).not.toMatch(/\b(?:\d{1,3}\.){3}\d{1,3}\b/);
    expect(content).not.toMatch(/apelogic/i);
  });

  test("pins every third-party release action to a commit", async () => {
    const workflow = await readFile(workflowPath, "utf8");
    const actionReferences = [...workflow.matchAll(/^\s*uses:\s*([^\s#]+).*$/gm)].map(
      (match) => match[1]
    );

    expect(actionReferences.length).toBeGreaterThan(0);
    for (const reference of actionReferences) {
      expect(reference).toMatch(/@[a-f0-9]{40}$/);
    }
  });
});
