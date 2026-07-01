# Burble Kubernetes consumer runbook

Audience: the client platform team deploying Burble from a fork or a private
deployment config repo.

## 1. Choose ownership boundaries

Decide which components Burble owns in this environment:

| Component | Chart-managed | Client-managed |
| --- | --- | --- |
| Burble app | always | n/a |
| LiteLLM | `litellm.mode=managed` | `litellm.mode=external` |
| agentgateway | `agentgateway.mode=managed` | `agentgateway.mode=external` |

If LiteLLM or agentgateway already exist as shared platform services, prefer
`external` and pass their URLs. If this is a standalone Burble install, use
`managed` to deploy them with the chart.

## 2. Create the secret source

Create a Kubernetes Secret directly or wire External Secrets Operator to your
secret manager. The app secret should contain only the keys your deployment
needs. Common keys:

```text
SLACK_BOT_TOKEN
SLACK_APP_TOKEN
SLACK_CLIENT_ID
SLACK_CLIENT_SECRET
GITHUB_CLIENT_ID
GITHUB_CLIENT_SECRET
JIRA_CLIENT_ID
JIRA_CLIENT_SECRET
GOOGLE_CLIENT_ID
GOOGLE_CLIENT_SECRET
HUBSPOT_CLIENT_ID
HUBSPOT_CLIENT_SECRET
OPENAI_API_KEY
ANTHROPIC_API_KEY
OLLAMA_API_KEY
INTERNAL_API_TOKEN
AGENT_RUNTIME_TOKEN_SECRET
AGENT_RUNTIME_SANDBOX_TOKEN
```

Never commit these values to the public fork.

## 3. Prepare private values

Example standalone values:

```yaml
image:
  repository: ghcr.io/<client-or-fork>/burble
  digest: sha256:<pinned-digest>

config:
  baseUrl: https://burble.example.com
  agentMode: llm
  agentRuntime: burble-runtime
  taskWorkflowShadowEnabled: "false"
  taskWorkflowAuthority: off

secret:
  existingSecret: burble-secrets

litellm:
  mode: managed

agentgateway:
  mode: managed
```

Example client-shared dependency values:

```yaml
image:
  repository: registry.example.com/burble
  digest: sha256:<pinned-digest>

config:
  baseUrl: https://burble.example.com

secret:
  existingSecret: burble-secrets

litellm:
  mode: external
  externalBaseUrl: https://litellm.platform.example.com/v1

agentgateway:
  mode: external
  externalUrl: https://agentgateway.platform.example.com/mcp
```

## 4. Deploy

```bash
helm upgrade --install burble ./deploy/k8s/chart \
  --namespace burble \
  --create-namespace \
  -f values-dev.yaml
```

For GitOps, commit the private values and a HelmRelease/Argo Application to the
client config repo. Pin images by digest and bump that digest deliberately.

## 5. Verify

```bash
kubectl -n burble rollout status deploy/burble
kubectl -n burble get pods,svc,pvc
kubectl -n burble port-forward svc/burble 3000:80
curl -fsS http://localhost:3000/healthz
```

Then test Slack:

- App Home loads.
- `/auth` returns provider connection controls.
- A DM such as `hello agent` runs through the configured runtime.
- Existing scheduled tasks continue to run with `TASK_WORKFLOW_AUTHORITY=off`.

Only after the shadow/oracle smoke tests pass should the operator consider
`TASK_WORKFLOW_SHADOW_ENABLED=true` or `TASK_WORKFLOW_AUTHORITY=manual`.
