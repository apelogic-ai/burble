# Burble Kubernetes Integration Contract

This is the short-form contract for platform teams integrating Burble into a
client Kubernetes environment. It intentionally avoids real hostnames, secret
values, account IDs, registry names, and customer-specific topology.

## Inputs

| Input | Required | Source |
| --- | --- | --- |
| `image.repository` plus `image.digest` or `image.tag` | yes | Private values overlay |
| `config.baseUrl` | yes | Public Burble URL for OAuth callbacks and links |
| `secret.existingSecret` or `externalSecret.*` | yes | Kubernetes Secret or External Secrets Operator |
| `ingress.*` | no | Client ingress/WAF/SSO platform |
| `persistence.*` | yes unless ephemeral dev | Client storage class and PVC policy |
| `litellm.mode` | yes | `managed`, `external`, or `disabled` |
| `agentgateway.mode` | yes | `managed`, `external`, or `disabled` |
| `networkPolicy.egress.*` | yes when NetworkPolicy is enabled | Client allowed CIDRs/selectors |

## Secret Keys

The app Secret may contain these keys. Only Slack bot/app tokens and GitHub
OAuth credentials are required for the basic app; the rest are conditional.

| Key | Purpose |
| --- | --- |
| `SLACK_BOT_TOKEN` | Slack bot API calls |
| `SLACK_APP_TOKEN` | Slack Socket Mode connection |
| `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET` | Optional Slack user OAuth |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | GitHub OAuth |
| `JIRA_CLIENT_ID`, `JIRA_CLIENT_SECRET` | Optional Jira OAuth |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Optional Google OAuth |
| `HUBSPOT_CLIENT_ID`, `HUBSPOT_CLIENT_SECRET` | Optional HubSpot OAuth |
| `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `OLLAMA_API_KEY` | Optional model provider keys |
| `INTERNAL_API_TOKEN` | Internal runtime/tool gateway bearer token |
| `AGENT_RUNTIME_TOKEN_SECRET` | Runtime JWT signing secret fallback |
| `AGENT_RUNTIME_SANDBOX_TOKEN` | Optional sandbox provider token |

## Dependency Modes

| Component | Managed mode | External mode | Disabled mode |
| --- | --- | --- | --- |
| LiteLLM | Chart deploys Deployment, Service, ConfigMap | Set `litellm.externalBaseUrl` | Burble inference gateway envs remain empty |
| agentgateway | Chart deploys Deployment, Service, ConfigMap | Set `agentgateway.externalUrl` | Burble uses direct internal MCP paths |

## Outputs

| Output | Notes |
| --- | --- |
| `Deployment/<release>` | Burble app, single replica by default |
| `Service/<release>` | Internal HTTP service, default service port 80 |
| `PVC/<release>` | App SQLite and runtime state when persistence is enabled |
| `ConfigMap/<release>-env` | Non-secret app env |
| `ExternalSecret/<release>` | Only when `externalSecret.enabled=true` |
| `Deployment/Service <release>-litellm` | Only when `litellm.mode=managed` |
| `Deployment/Service <release>-agentgateway` | Only when `agentgateway.mode=managed` |

## Non-Goals

- The chart does not create cloud IAM roles, DNS records, WAF policies, or
  secret-manager entries.
- The chart does not provide horizontal app scaling while SQLite is the primary
  store.
- The chart does not model a full production sandbox control plane; it passes
  Burble's sandbox/OpenShell config to the app.
