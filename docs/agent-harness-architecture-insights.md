# Agent Harness Architecture Insights

Status: untracked working note.

Source reviewed:

- X post/article: <https://x.com/mfpiccolo/status/2060069083878408689>
- iii docs: <https://iii.dev/docs>
- iii engine repository: <https://github.com/iii-hq/iii>
- iii harness workers: <https://github.com/iii-hq/workers/tree/main/harness>
- iii worker registry: <https://workers.iii.dev/>

## Short Read

The post argues that an agent harness should not be treated as one framework
decision. A production harness is really a set of separable responsibilities:
turn acceptance, state machine, provider credentials, model catalog, policy,
approval gates, budget tracking, hooks, session storage, compaction, event
streaming, and tracing.

The strongest actionable insight for Burble is to make the harness boundary
more explicit. Burble already has some of the right separation:

- Burble control plane owns identity, OAuth, routes, policy, and audit intent.
- Runtimes own agent execution.
- Burble provider MCP exposes route-scoped provider tools.
- agentgateway is only ingress/auth/routing in front of MCP, not application
  policy.

The weaker part is that some harness concerns are implicit or split across
runtime code, Burble control-plane code, provider MCP, and docs. The product
will be easier to defend if these concerns become named contracts.

## What The Post Is Really Saying

The post's architecture claim is:

1. Agent frameworks bundle too many independent concerns.
2. Teams eventually want to replace one concern without replacing the whole
   harness.
3. A shared worker/function/trigger substrate makes each concern independently
   swappable.
4. Thin vs thick harness should be a deploy-time composition choice, not a
   rewrite.

iii implements this through workers that register functions and triggers on a
shared engine bus. Its docs describe the primitives as Worker, Trigger, and
Function; its harness repository currently shows separate workers for the
turn orchestrator, session storage, approval gate, model providers, auth
credentials, model catalog, budget tracking, hook fanout, and compaction.

## Burble Fit

Burble's architecture is not obviously wrong against this critique. It is
actually defensible because Burble is not trying to be a general agent
framework. Burble is a control plane around enterprise/user context:

- who is asking;
- which workspace and route the work belongs to;
- which provider accounts and tools are allowed;
- which runtime is allowed to act;
- where output can be delivered;
- how events and tool usage are audited.

That is a different product proposition from LangChain/LangGraph/CrewAI-style
agent orchestration, and also different from a generic MCP gateway.

The Burble-specific value is the boundary between an enterprise surface
and arbitrary agent runtimes. Runtimes can be OpenClaw/NemoClaw today,
Hermes later, or something else, as long as they obey Burble's contracts.

## Actionable Architecture Changes

### 1. Name Burble's Harness Contracts

Create an explicit internal contract map for:

- `TurnIngress`: accepting a user/workspace/conversation turn.
- `RuntimeDispatch`: sending a normalized run request to a runtime.
- `ProviderToolPlane`: route-scoped MCP/provider tool access.
- `DeliveryPlane`: sending output through a Burble route.
- `PolicyPlane`: runtime, route, provider, tool, and job policy decisions.
- `ApprovalPlane`: human approvals for risky or sensitive actions.
- `AuditPlane`: structured events across every step.
- `BudgetPlane`: model/tool/job spend tracking.
- `MemoryPlane`: runtime/session memory ownership and scoping.

This does not require adopting a worker bus. It gives Burble the same
replaceability benefits at the product boundary level.

### 2. Make Runtime Swappability A First-Class Product Property

Burble should document and test a stable runtime API:

- start run;
- stream events;
- pass active route context;
- pass runtime manifest/policy hash;
- expose provider tools only through Burble MCP;
- deliver background output only through route capabilities.

This keeps OpenClaw/NemoClaw as an implementation, not the architecture.

### 3. Pull Policy Out Of Runtime Prompts

Current runtime prompt instructions are useful, but they are not a hard
security boundary. The policy surface should live in Burble:

- job-scoped runtime JWTs;
- allowed tool intersection;
- route validation;
- delivery capability validation;
- max output visibility;
- tool-output tainting;
- approval gates.

The runtime can receive instructions, but Burble should enforce the final
decision.

### 4. Add A Shared Trace Shape

The post calls out one trace across every step. That is worth adopting.

Burble should define a trace/event schema that follows:

- Slack/user ingress event;
- runtime selection;
- runtime run start;
- model request, if visible;
- provider MCP list/call;
- policy decision;
- approval request/decision;
- delivery attempt;
- delivery result;
- errors and retries.

Each event should include at least:

- `workspaceId`;
- `slackUserId` or service principal;
- `runtimeId`;
- `routeId`, when present;
- `jobId`, when present;
- `toolName`, when present;
- `policyHash`;
- `traceId`;
- `parentEventId`.

This would make cross-runtime and cross-user leakage reviews much easier.

### 5. Treat Approval, Budget, And Hooks As Missing Workers

Burble should not necessarily copy iii's worker stack, but the missing
concerns are real product concerns:

- approval gate for high-risk tools and output release;
- budget tracker for LLM/tool usage by workspace, user, agent, and job;
- hook fanout for redaction, logging, DLP, notifications, and custom customer
  controls;
- context compaction policy, if Burble owns or audits memory later.

These should be designed as replaceable internal modules or services, not
buried inside one runtime adapter.

### 6. Keep MCP Gateway Scope Narrow

The post reinforces the earlier conclusion: a generic MCP gateway is not
the Burble product. Burble MCP is a provider/control-plane adapter:

- it maps runtime identity to user/workspace/provider identity;
- it validates routes;
- it intersects allowed tools;
- it records tool calls;
- it hides provider OAuth handling from runtimes.

agentgateway remains swappable as ingress, but not as Burble's policy brain.

## What Not To Adopt Blindly

Do not replace Burble's architecture with a generic worker bus just because
iii uses one. A bus solves integration shape; it also adds a new substrate,
operational model, registry model, and trust boundary.

For Burble, the more pragmatic step is:

- keep Burble as the authority/control plane;
- keep runtimes replaceable;
- make the contracts explicit;
- enforce policy in Burble;
- add tracing and audit as first-class flows.

## Product Positioning

Burble is best positioned as an agent control plane for enterprise context,
not as another agent harness and not as only an MCP gateway.

Suggested framing:

> Burble lets any agent runtime work safely inside a company's existing
> collaboration, identity, and SaaS context. It provides route-scoped tools,
> delegated provider access, runtime policy, delivery controls, and audit,
> while keeping the actual agent harness replaceable.

That framing fits the current system better than "MCP gateway" and avoids
competing head-on with framework/runtime projects.

## Near-Term Checklist

1. Write a runtime contract spec for Burble runtimes.
2. Add conformance tests for at least two runtime implementations or a mock
   runtime plus OpenClaw/NemoClaw.
3. Convert route delivery into explicit signed or server-side capabilities.
4. Add runtime ingress authentication.
5. Add structured trace IDs across Slack ingress, runtime dispatch, MCP calls,
   and delivery.
6. Introduce a policy decision record for every provider tool call and
   delivery attempt.
7. Design approval and budget modules as independent Burble services/modules.

