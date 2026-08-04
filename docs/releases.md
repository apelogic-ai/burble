# Releases

Burble releases define a stable source and deployment-template boundary for promoting the Slack
agent backend through dev, staging, and customer environments.

## Versioning

Use SemVer:

- `MAJOR`: breaking changes to runtime contracts, provider tool contracts, deployment shape,
  database state, environment variables, Slack app requirements, or documented operator workflows.
- `MINOR`: backward-compatible features such as new provider tools, runtime engines, scheduler
  capabilities, deployment options, or optional integrations.
- `PATCH`: bug fixes, documentation fixes, test improvements, and non-breaking deployment-template
  corrections.

The current release line is `v0.1.2`.

## Release Artifacts

Each release should provide:

- an annotated Git tag named `vX.Y.Z`;
- a GitHub Release generated from that tag;
- the source archive GitHub attaches to the release;
- a Linux/amd64 application image in the configured private ECR repository;
- an OCI Helm chart in the configured private ECR repository;
- immutable image and chart digest references in the release report;
- SPDX SBOM, build-provenance, registry-scan, and vulnerability-scan evidence;
- digest signatures and OCI attestations for both the image and chart;
- release notes calling out operator-impacting changes and required migration steps.

The workflow publishes only immutable version tags and digest-addressed evidence. It does not
publish a moving `latest` tag. Private GitOps configuration should consume the digest references
from the release report rather than deriving coordinates from the source tag.

## Repository Configuration

Configure release infrastructure through GitHub repository variables only:

| Variable | Purpose |
| --- | --- |
| `AWS_RELEASE_ROLE_ARN` | AWS IAM role trusted by GitHub OIDC for release publishing |
| `AWS_REGION` | Region containing the target ECR repositories |
| `ECR_REGISTRY` | ECR registry hostname without a URL scheme |
| `BURBLE_ECR_IMAGE_REPOSITORY` | ECR repository path for the application image |
| `BURBLE_ECR_CHART_REPOSITORY` | ECR repository path for the chart; its final segment must be `burble` |

The role, registry, and repository coordinates are not stored as repository secrets or committed
values. The OIDC role should grant only the ECR operations needed to authenticate, push both
artifacts, inspect/start image scanning, and publish signature and attestation manifests.

ECR scanning must be enabled for the application image repository. A release fails before creating
the GitHub Release when the scan does not reach a usable state or reports any unresolved critical
finding.

## Cutting A Release

1. Start from a clean `main`.
2. Update `package.json`, `packages/runtime-sdk/package.json`, and
   `deploy/k8s/chart/Chart.yaml` to the target SemVer version.
3. Move relevant `CHANGELOG.md` entries from `Unreleased` to the target version.
4. Run local gates:

   ```bash
   bun install
   bun run ci
   bun run deploy:check
   bun run release:check
   ```

5. Commit the version and changelog update.
6. Create and push an annotated tag:

   ```bash
   git tag -a vX.Y.Z -m "vX.Y.Z"
   git push origin vX.Y.Z
   ```

7. Wait for the `Release` workflow to pass. It reruns CI and deployment-template checks, assumes the
   configured AWS role through GitHub OIDC, publishes and verifies both artifacts, enforces the ECR
   critical-finding gate, and creates the GitHub Release with evidence and immutable digests.

## Private GitOps Consumption

Authenticate Helm and the container runtime to the private ECR registry using the deployment
environment's workload identity. Pull the chart by its version, verify its reported digest, and pin
the application image by the image digest from the same release report.

The chart remains environment-neutral. Supply hostnames, ingress settings, secret references,
registry credentials, and artifact digests through the consuming GitOps repository. For externally
managed dependencies:

- set `litellm.mode=external` and configure `litellm.external.url`;
- provide `BURBLE_INFERENCE_API_KEY` in the application secret as the bearer credential for the
  external LiteLLM endpoint;
- set `agentgateway.mode=external` and configure `agentgateway.external.mcpUrl` plus the external
  identity audience/issuer values.

The external-mode render contract verifies that the chart does not create bundled LiteLLM or MCP
gateway workloads. A generic render example is maintained at
`deploy/k8s/chart/ci/external-values.yaml`.

## Promotion Guidance

Downstream deployments should pin release tags, not moving branches, when promoting Burble.
Private overlays should keep customer hostnames, secrets, registry credentials, and image digests
outside this repository.
