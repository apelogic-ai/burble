# Burble Kubernetes Enterprise Deployment Readiness

This is the generic readiness guide for running Burble in an enterprise
Kubernetes platform. It maps the deployment controls a platform team usually
asks for to Burble's current deployment artifacts and the decisions that stay
with the client operator.

Burble's public repo should contain only reusable deployment logic. Client
hostnames, registry names, Slack app credentials, OAuth clients, provider API
keys, ingress annotations, and secret-store references belong in a private
deployment overlay.

## Deployment Model

- **GitOps-friendly Helm chart.** `deploy/k8s/chart` deploys the Burble app and
  can optionally deploy LiteLLM and agentgateway. Flux and Argo CD examples
  live in `deploy/k8s/examples`.
- **Private overlay.** The client supplies image digests, public URLs, ingress
  annotations, provider choices, and secret-store refs from a private repo or
  fork.
- **Socket Mode Slack app.** Burble does not need a public Slack event
  endpoint, but OAuth callbacks, health checks, App Home links, and provider
  callbacks still need `BASE_URL`.
- **Stateful single writer.** Burble currently uses SQLite under `/data`; the
  chart defaults to one replica and a PVC. Horizontal scale needs a future
  shared database and leader-election pass.
- **Optional platform dependencies.** LiteLLM and agentgateway can be deployed
  by the chart (`managed`) or supplied by the client as existing services
  (`external`).

## Required Operator Decisions

| Area | Decision |
| --- | --- |
| Image source | Which registry and pinned digest to deploy. |
| Secret source | Existing Kubernetes Secret or External Secrets Operator. |
| Edge | Ingress class, TLS, WAF, SSO/IP allowlist policy, and callback hostnames. |
| LiteLLM | Chart-managed service or existing platform LiteLLM/OpenAI-compatible endpoint. |
| agentgateway | Chart-managed MCP gateway or existing platform agentgateway endpoint. |
| Storage | PVC storage class, backup policy, restore procedure, and retention. |
| Workflow rollout | Keep `TASK_WORKFLOW_AUTHORITY=off` initially; enable shadow/authority only after smoke tests. |

## Control Mapping

### Deployment And Supply Chain

| Control | Current state | Owner |
| --- | --- | --- |
| Kubernetes manifests | Helm chart in `deploy/k8s/chart` | Burble |
| GitOps examples | Flux and Argo CD examples in `deploy/k8s/examples` | Burble |
| Image digest pinning | Supported by `image.digest`; client must pin | Shared |
| Image signing/scanning | Not enforced by the chart | Client/operator policy |
| Ingress/WAF/TLS | Chart exposes pass-through ingress fields | Client/operator |
| Runtime dependencies | LiteLLM and agentgateway support `managed` or `external` modes | Shared |

### Secrets

| Control | Current state | Owner |
| --- | --- | --- |
| No secrets in values | Chart reads secrets through `secret.existingSecret` or `externalSecret` | Burble |
| Slack credentials | Required Secret keys: `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN` | Client |
| OAuth clients | GitHub required; Jira/Google/HubSpot/Slack user OAuth optional | Client |
| Provider keys | Optional `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `OLLAMA_API_KEY` | Client |
| Runtime auth | Optional `INTERNAL_API_TOKEN`, `AGENT_RUNTIME_TOKEN_SECRET`, sandbox token | Client |
| Secret rotation | Supported by Kubernetes/ESO refresh; app restart policy is operator-defined | Client |

### State And Data

| Control | Current state | Owner |
| --- | --- | --- |
| Primary DB | SQLite at `/data/burble.db` on PVC | Burble/client |
| Workflow shadow DB | Optional sidecar SQLite file when shadow is enabled | Burble/client |
| Audit retention | Configurable via `SCHEDULED_RUN_AUDIT_RETENTION_DAYS` and prune interval | Burble |
| Backups | PVC/database backup policy not defined by chart | Client/operator |
| Multi-replica safety | Not supported yet; chart defaults to one replica | Burble |

### Network

| Control | Current state | Owner |
| --- | --- | --- |
| NetworkPolicy | Default-deny with explicit DNS, HTTPS CIDRs, and managed dependency egress | Burble/client |
| Public routes | `/internal/*` must not be exposed by ingress | Client/operator |
| Slack connectivity | Outbound HTTPS/WebSocket to Slack required for Socket Mode | Client/operator |
| Provider connectivity | Outbound HTTPS to GitHub, Atlassian, Google, HubSpot, model providers | Client/operator |
| MCP gateway | Internal Service when managed; external URL when platform-owned | Shared |

### Runtime And Agent Dependencies

| Control | Current state | Owner |
| --- | --- | --- |
| In-process runtime | `AGENT_RUNTIME=ai-sdk` still supported | Burble |
| Managed Burble runtime | `AGENT_RUNTIME=burble-runtime` supported | Burble |
| LiteLLM | `litellm.mode=managed|external|disabled` | Shared |
| agentgateway | `agentgateway.mode=managed|external|disabled` | Shared |
| Sandbox/OpenShell provider | Config fields are present, but cluster-specific deployment is client/platform work | Shared |

## Workflow Rollout Policy

Use this sequence for production-like environments:

1. Deploy with `TASK_WORKFLOW_AUTHORITY=off`.
2. Confirm App Home, provider OAuth, Slack delivery, scheduled task creation,
   and normal scheduled runs work.
3. Enable `TASK_WORKFLOW_SHADOW_ENABLED=true` only after the shadow database
   path is persistent and backed up.
4. Let shadow recording, maintenance, oracle, and reconciliation run through at
   least one scheduled-task cycle.
5. Review logs for oracle mismatches and workflow reconcile events.
6. Only then consider `TASK_WORKFLOW_AUTHORITY=manual`, starting with a low-risk
   manual task.

Do not enable workflow authority and a new runtime topology in the same deploy.

## Client Integration Checklist

- Create the Slack app and set Socket Mode tokens.
- Register OAuth callbacks for any enabled providers:
  - `https://<base-url>/oauth/github/callback`
  - `https://<base-url>/oauth/jira/callback`
  - `https://<base-url>/oauth/google/callback`
  - `https://<base-url>/oauth/hubspot/callback`
  - `https://<base-url>/oauth/slack/callback`
- Create the app Secret or ExternalSecret mapping.
- Choose LiteLLM and agentgateway modes.
- Set ingress/edge controls and confirm `/internal/*` is not public.
- Run `helm lint` and `helm template` against the private values.
- Deploy to a dev namespace first.
- Smoke-test `/healthz`, App Home, provider auth, a DM turn, a manual task run,
  and one scheduled task run.

## Known Limits Before Broad Rollout

- Single replica only while SQLite is the primary store.
- PVC backup/restore is operator-owned and must be defined per environment.
- Workflow authority should remain off until shadow/oracle smoke tests pass in
  that environment.
- Sandbox/OpenShell runtime deployment is platform-specific; this chart passes
  the config but does not fully model a production sandbox control plane.
