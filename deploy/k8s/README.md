# Burble on Kubernetes

This directory contains a reusable Kubernetes deployment blueprint for Burble.
The public repo owns generic deployment logic, while each client keeps
environment-specific values and secrets in its own private deployment overlay.

Burble is stateful today: the app uses SQLite under `/data`, Slack Socket Mode,
and scheduler loops. The chart therefore defaults to one replica plus a
PersistentVolumeClaim. Scale-out requires a future shared database and leader
election pass.

## Deployment shape

```
public repo fork / chart          private client config repo
deploy/k8s/chart/**       <--    values-{env}.yaml, ExternalSecret refs,
generic templates                 image digests, hostnames, ingress/WAF,
                                  runtime endpoints, secret-store keys
```

The chart supports three dependency modes:

- Burble app: always deployed by this chart.
- LiteLLM: `managed`, `external`, or `disabled`.
- agentgateway: `managed`, `external`, or `disabled`.

Use `managed` when the cluster should run the component from this chart. Use
`external` when the client already has a shared service and Burble should only
receive its URL.

## Required private values

At minimum, the client overlay must set:

- `image.repository` and `image.digest` or `image.tag`
- `config.baseUrl`
- `secret.existingSecret` or `externalSecret.enabled=true`
- provider/client secrets in that Kubernetes Secret:
  - `SLACK_BOT_TOKEN`
  - `SLACK_APP_TOKEN`
  - `GITHUB_CLIENT_ID`
  - `GITHUB_CLIENT_SECRET`
  - optional provider keys such as `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`,
    `JIRA_CLIENT_ID`, `GOOGLE_CLIENT_ID`, and matching secrets

Do not put OAuth secrets, Slack tokens, provider API keys, customer hostnames,
or registry credentials in this public repo.

## LiteLLM modes

Managed LiteLLM:

```yaml
litellm:
  mode: managed
```

The chart creates a LiteLLM Deployment, ConfigMap, and Service, and points
`LLM_GW_BASE_URL` / `BURBLE_INFERENCE_BASE_URL` at it.

External LiteLLM:

```yaml
litellm:
  mode: external
  externalBaseUrl: https://litellm.example.internal/v1
```

The chart deploys no LiteLLM workload and only passes the URL to Burble.

## agentgateway modes

Managed agentgateway:

```yaml
agentgateway:
  mode: managed
```

The chart creates an agentgateway Deployment, ConfigMap, and Service. Burble's
runtime MCP gateway URL and audience point at that in-cluster service.

External agentgateway:

```yaml
agentgateway:
  mode: external
  externalUrl: https://agentgateway.example.internal/mcp
```

The chart deploys no agentgateway workload and only passes the URL to Burble.

## Validate locally

```bash
helm lint deploy/k8s/chart -f deploy/k8s/chart/ci/test-values.yaml
helm template burble deploy/k8s/chart -f deploy/k8s/chart/ci/test-values.yaml
```

## Install example

```bash
helm upgrade --install burble deploy/k8s/chart \
  --namespace burble --create-namespace \
  -f values-dev.yaml
```

See [`CONSUMER.md`](./CONSUMER.md) for the longer client onboarding runbook.
See [`INTEGRATION.md`](./INTEGRATION.md) for the concise chart contract sheet.
