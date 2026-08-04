# Changelog

All notable changes to this project are documented here.

## [Unreleased]

## [0.1.3]

- Refresh final application-image OS packages before installing runtime tools so immutable
  releases include current Alpine security fixes and pass the critical-finding gate.

## [0.1.2]

- Add the deployable Burble Native runtime, scalable runtime-skill loading, and stricter managed
  runtime terminal/tool-call handling.
- Route Google and GitHub authorization and supported tools through MCP-GW without exposing
  downstream provider credentials to Burble.
- Preserve, preflight, and enforce scheduled-task capability, operation, state, and delivery
  contracts; fail legacy or incomplete tasks explicitly.
- Harden SQLite ownership, provider retries, runtime timeouts, diagnostics, and scheduled-run
  serialization.
- Publish signed Linux/amd64 application images and OCI Helm charts to private ECR with immutable
  digests, SBOMs, provenance, vulnerability evidence, and a critical-finding release gate.

## [0.1.1]

- Establish release automation and release metadata checks.
- Route supported runtime Google tools through hosted MCP-GW while preserving
  fallback behavior for operations MCP-GW cannot express yet.

## [0.1.0]

- Initial Burble Slack agent backend release line.
- Includes runtime contract support, provider tools, scheduled jobs, sandbox runtimes,
  dev Compose deployment, and Kubernetes deployment blueprints.
