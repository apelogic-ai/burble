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

The current initial release line is `v0.1.0`.

## Release Artifacts

Each release should provide:

- an annotated Git tag named `vX.Y.Z`;
- a GitHub Release generated from that tag;
- the source archive GitHub attaches to the release;
- the matching Compose files, Helm chart, Terraform, Ansible templates, runtime Dockerfiles, and
  runtime SDK source from that tag;
- release notes calling out operator-impacting changes and required migration steps.

Container images are intentionally not part of the first release contract. Operators can build from
the release tag, mirror images into private registries, and pin private image digests in overlays.
Public image publishing and signing can be added once the registry, provenance, and support model
are decided.

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

7. Wait for the `Release` workflow to pass. It reruns CI and deployment-template checks, then
   creates the GitHub Release with generated notes.

## Promotion Guidance

Downstream deployments should pin release tags, not moving branches, when promoting Burble.
Private overlays should keep customer hostnames, secrets, registry credentials, and image digests
outside this repository.
