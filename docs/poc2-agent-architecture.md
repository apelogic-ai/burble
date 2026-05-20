# PoC2 Agent Architecture

PoC2 turns the authn PoC into a Slack-native work assistant. Users invoke
Burble by mentioning the app in Slack, and Burble answers questions using the
requester's authenticated provider connections. GitHub remains the first
provider, and Jira is added as the second provider to prove the shape is not
GitHub-specific.

## Goals

- Use `@Burble ...` mentions as the primary UX.
- Reuse the existing per-user GitHub OAuth connection.
- Add Jira as a second authenticated provider.
- Add an agent harness with controlled provider tool access.
- Keep OAuth tokens out of model prompts and model-visible context.
- Enforce safe response visibility in shared Slack channels.
- Support a path from narrow typed tools to broader provider capabilities via
  MCP or sandboxed CLIs.
- Keep the implementation TS/Bun for PoC2, while preserving a clean future
  migration boundary for an Elixir/BEAM orchestrator.

## Non-Goals

- No raw provider credentials in the model context.
- No service-account GitHub access.
- No public channel dumps of requester-scoped data.
- No durable multi-turn memory beyond the current Slack thread in PoC2.
- No provider-general OAuth dashboard yet. `/auth` remains the setup surface.
- No arbitrary shell execution as the default provider interface. CLI-backed
  provider access must run through a constrained sandbox and typed wrapper.

## Runtime Shape

```text
Slack app mention
  -> Slack Gateway
  -> Conversation Orchestrator
  -> Agent Runner
  -> Tool Registry
  -> Provider Execution Layer
  -> GitHub / Jira / MCP / sandboxed CLI
  -> Visibility Policy
  -> Slack reply
```

### Slack Gateway

Owns Bolt and Slack-specific behavior:

- Socket Mode startup.
- `app_mention` events.
- `/auth` command fallback.
- Slack user email lookup.
- Slack response transport: public thread reply, ephemeral message, or DM.

It should not contain agent logic.

### Conversation Orchestrator

Owns the normalized request pipeline:

- Normalize Slack event into a JSON-safe `ConversationRequest`.
- Load user connection state.
- Route setup intents such as `connect github`.
- Invoke the agent runner for provider-backed questions.
- Pass responses through visibility policy before Slack delivery.

This is the future BEAM migration boundary. In PoC2 it is an in-process TS
module. Later, the Slack gateway can POST this request to an Elixir service or
publish it to a queue.

### Agent Runner

Owns model/runtime interaction:

- Supplies a small system prompt.
- Supplies provider tool schemas.
- Executes model-selected tools server-side.
- Produces a short Slack-ready answer.

The model never receives access tokens.

The runner is a pluggable boundary. Burble's conversation layer calls the
same `AgentRunner` interface whether the implementation is the in-process AI
SDK runner or an out-of-process OpenClaw/NemoClaw runtime.

```ts
type AgentRunner = {
  name: string;
  capabilities: {
    streaming: boolean;
    toolEvents: boolean;
    remote: boolean;
    requiresToolGateway?: boolean;
  };
  run(input: AgentInput): AsyncIterable<AgentRunEvent>;
};
```

Current runners:

- `ai-sdk` — direct TypeScript/Bun runner using AI SDK provider packages.
- `openclaw-nemoclaw` — remote runner adapter that POSTs sanitized input to a
  sandbox/runtime service.

`AGENT_MODE=llm` enables agent routing. `AGENT_RUNTIME` selects the runtime.
The default is `AGENT_RUNTIME=ai-sdk`.

### OpenClaw/NemoClaw Packaging

OpenClaw/NemoClaw runs outside the Burble process and is optional in dev
deployment. Burble remains the product/security boundary:

```text
Slack
  -> Burble Slack Adapter
  -> Conversation Orchestrator
  -> AgentRunner interface
      -> ai-sdk
      -> openclaw-nemoclaw adapter
          -> OpenClaw/NemoClaw runtime service
  -> Visibility Policy
  -> Slack reply
```

The adapter sends only sanitized connection summaries to the remote runtime:

```ts
{
  input: {
    text: string;
    connections: {
      github: {
        connected: boolean;
        email?: string;
        providerLogin?: string;
      };
    };
  };
}
```

Provider OAuth tokens remain inside Burble. A future OpenClaw plugin must call
back through a Burble tool gateway rather than reaching GitHub/Jira/Slack
directly.

The first gateway endpoint is:

```text
POST /internal/tools/:toolName/execute
Authorization: Bearer ${INTERNAL_API_TOKEN}
```

Initial tool names:

- `github.getAuthenticatedUser`
- `github.listAssignedIssues`
- `github.searchIssues`
- `github.listMyPullRequests`

The request identifies the Burble user, not the provider token:

```json
{
  "user": { "email": "person@example.com" },
  "input": { "query": "is:issue billing" }
}
```

The response is the same classified, sanitized tool result shape used by the
in-process runner. `Caddyfile` blocks `/internal/*` from the public hostname;
runtime services call the gateway over the private compose network.

### Tool Registry

Owns allowed tool definitions and execution:

- connection tools such as `connections.list`
- GitHub tools
- Jira tools
- future MCP-backed tools
- future sandboxed CLI-backed tools

Tools receive an execution context that includes the provider token, but tool
results returned to the model are capped and sanitized.

The registry is a policy boundary. "Broader access" should mean more tool
surface behind typed contracts, not unmediated provider credentials in the
prompt.

### Provider Execution Layer

Provider access can use several backends. The orchestrator and agent should not
care which backend executes a tool.

#### Typed HTTP Clients

Best for the first production-grade path:

- OAuth URL construction.
- OAuth code exchange.
- provider REST/GraphQL calls.
- predictable request/response types.

#### Provider MCP Servers

Preferred when a trustworthy MCP server is available for the provider:

- GitHub MCP can expose broader repository, issue, PR, and search operations.
- Atlassian/Jira MCP can expose issue search and project metadata.
- Burble still wraps MCP tools in policy: token source, allowed operations,
  result caps, audit logging, and visibility classification.

MCP does not remove authz responsibility. It is an execution substrate.

#### Sandboxed CLI Wrappers

Useful for PoC breadth or providers whose CLI is better than their SDK:

- GitHub CLI (`gh`) with a per-user token injected only into a sandboxed
  process environment.
- Atlassian/Jira CLI only if it can accept scoped per-user credentials without
  writing long-lived secrets to disk.
- Strict command allowlist, argument schema validation, timeout, output cap,
  and no shell interpolation.

CLI wrappers are acceptable for PoC exploration, but typed HTTP/MCP tools are
preferred for durable behavior.

Provider clients do not know about Slack or the agent.

## Request and Response Contracts

All orchestration contracts should be JSON-safe and free of Bolt types.

```ts
type ConversationRequest = {
  source: "slack";
  workspaceId: string;
  channelId: string;
  threadTs?: string;
  messageTs: string;
  isDirectMessage: boolean;
  user: {
    slackUserId: string;
    email: string;
  };
  text: string;
};

type ConversationResponse = {
  visibility: "public" | "ephemeral" | "dm";
  text: string;
  blocks?: unknown[];
};
```

PoC2 can keep this in-process. The contract shape is deliberately compatible
with a future remote orchestrator.

## Token Safety

OAuth tokens stay in the store and server-side tool execution context.

Allowed:

```text
model -> tool call: github.searchIssues({ query: "assignee:@me is:open" })
tool executor -> provider backend with user's token
tool result -> capped title/url/state list
model -> final answer
```

Forbidden:

```text
model prompt includes GitHub token
model output includes token
tool returns raw provider responses without caps
sandboxed CLI receives unvalidated model-generated shell text
```

## Shared Channel Visibility

Requester-scoped data must not be posted publicly in shared Slack channels by
default.

There are two authorization questions:

1. Can the requester access the data?
2. Can every Slack audience member see the response?

GitHub/Jira OAuth only answers the first question. PoC2 treats channel/thread
audiences as mixed-permission unless proven otherwise.

### Policy

- DMs with Burble may show requester-scoped results.
- Channel mentions with user-scoped tool results use ephemeral response or DM.
- Public channel replies are allowed only for public/help/setup text.
- Explicit sharing is out of scope for PoC2.

Tool results carry a classification:

```ts
type ToolClassification = "public" | "user_private" | "restricted";
```

GitHub and Jira user-scoped tools default to `user_private`.

Policy rule:

```text
if response includes user_private or restricted data and target is a channel:
  visibility = ephemeral
```

This avoids leaking data to channel members with different GitHub permissions.

## Slack UX

Primary:

```text
@Burble connect github
@Burble connect jira
@Burble who am I on GitHub?
@Burble what issues are assigned to me?
@Burble what Jira tickets are assigned to me?
```

Fallback/admin:

```text
/auth
/auth github
/auth jira
/github-me x
/issues x
```

`/auth` remains useful for setup, but PoC2 should demo mentions.

## Module Layout

Target layout:

```text
src/slack/
  runtime.ts
  mention-handler.ts
  command-handler.ts
  formatting.ts

src/conversation/
  orchestrator.ts
  types.ts
  visibility.ts

src/agent/
  runtime.ts
  runner.ts
  runners/
    openclaw-nemoclaw.ts
  prompts.ts
  types.ts

src/tools/
  registry.ts
  github.ts
  jira.ts
  types.ts

src/providers/github/
  client.ts
  oauth.ts
  types.ts

src/providers/jira/
  client.ts
  oauth.ts
  types.ts

src/providers/mcp/
  client.ts
  types.ts

src/providers/cli/
  sandbox.ts
  types.ts

src/store/
  connections.ts
  oauth-state.ts
  schema.ts
```

PoC2 can migrate gradually from the current flat files. Avoid a large
directory reshuffle until tests cover the new contracts.

## Data Model Evolution

Current:

```text
users(email, slack_user_id, github_login, github_token)
oauth_state(state, slack_user_id, expires_at)
```

Target:

```text
connections(
  id,
  provider,
  slack_user_id,
  email,
  provider_account_id,
  provider_login,
  access_token,
  refresh_token,
  scopes,
  connected_at,
  updated_at
)

oauth_state(
  state,
  slack_user_id,
  provider,
  return_context,
  expires_at,
  created_at
)
```

The target avoids hardcoding GitHub into the store and prepares for Atlassian,
Salesforce, and `db-mcp`.

## Implementation Plan

### Slice 1: Mention Harness, No LLM

Add Slack scope:

```text
app_mentions:read
```

Then enable Slack Event Subscriptions, subscribe the bot to `app_mention`,
reinstall the app, and invite Burble to test channels. Socket Mode means Slack
does not need a Request URL, but the event subscription is still required.

Implement:

- `ConversationRequest` and `ConversationResponse` types.
- `app_mention` handler.
- Mention text normalization: strip `<@BOT_ID>`.
- Deterministic intents:
  - `connect github`
  - `connect jira`
  - `who am I on GitHub`
  - `issues assigned to me`
  - `my pull requests`
  - `search GitHub issues`
  - `Jira tickets assigned to me`
- Visibility enforcement.

Tests:

- mention text normalization.
- no GitHub connection returns private setup instruction.
- channel result visibility is ephemeral.
- DM result visibility can be direct.

### Slice 2: Provider Store Generalization

Refactor current `users` table access behind a connection repository.

Implement compatibility first:

- keep existing schema
- expose provider-shaped API

Then migrate schema when needed.

Tests:

- lookup provider connection by Slack user/email/provider.
- no token appears in serialized agent/model context.

### Slice 3: Provider Execution Strategy Spike

Decide and document the first backend per provider:

- GitHub: typed HTTP client first, with a path to GitHub MCP for broader repo
  operations.
- Jira: typed HTTP client first unless an Atlassian MCP server is available
  and can be run with per-user OAuth safely.

For CLI-backed tools, build only a narrow sandbox wrapper and do not expose it
directly to the model.

Tests:

- selected backend receives a token through execution context only.
- command/operation allowlist rejects unknown operations.
- output caps are enforced.

### Slice 4: GitHub Tool Registry

Implement typed tools:

- `github.getAuthenticatedUser`
- `github.listAssignedIssues`
- `github.searchIssues`
- `github.listMyPullRequests`

Each tool returns:

```ts
{
  classification: "user_private",
  content: ...
}
```

Tests:

- tool uses caller token.
- results are capped.
- raw token is not present in tool result.

### Slice 5: Jira Connection and Tool Registry

Implement Jira as the required second provider.

Minimum tools:

- `jira.getAuthenticatedUser`
- `jira.listAssignedIssues`
- `jira.searchIssues`

Minimum OAuth/auth work:

- Add `/auth jira` and `@Burble connect jira`.
- Store Jira cloud/site/account metadata in `connections`.
- Use per-user Jira credentials for tool execution.

Tests:

- unconnected Jira requests produce a private connect prompt.
- Jira assigned-ticket tool uses caller credentials.
- Jira results are classified `user_private`.

### Slice 6: Agent Runner

Add model/tool loop.

The runner input:

```ts
{
  message: string;
  tools: ToolRegistry;
  userContext: { email: string; githubLogin?: string };
}
```

The runner output:

```ts
{
  answer: string;
  classifications: ToolClassification[];
}
```

Tests:

- tool-call transcript uses schemas, not tokens.
- unknown GitHub request asks a clarifying question.
- unconnected user is not sent to the model for provider data requests.
- provider selection works for GitHub vs Jira requests.

### Slice 6b: Pluggable Runner Boundary

Package the runner as an event-based interface:

- `src/agent/types.ts` defines `AgentRunner`, `AgentRunEvent`, and collection
  helpers.
- `src/agent/runtime.ts` selects a configured runner.
- `src/agent/runner.ts` remains the in-process AI SDK implementation.
- `src/agent/runners/openclaw-nemoclaw.ts` is the remote runtime adapter.

Deployment:

- base compose runs `AGENT_RUNTIME=ai-sdk`.
- optional compose override adds an `openclaw-nemoclaw` service and sets
  `AGENT_RUNTIME=openclaw-nemoclaw`.

Tests:

- both runners satisfy the same contract.
- remote adapter does not serialize provider access tokens.
- missing remote runtime URL fails at startup.

### Slice 7: Audit Log

Log:

- Slack user ID.
- workspace/channel/thread.
- provider.
- tool name.
- argument summary.
- result count.
- visibility decision.

Do not log tokens or raw provider payloads.

## Definition of Done

PoC2 is complete when:

1. User A can run:

   ```text
   @Burble connect github
   @Burble connect jira
   @Burble who am I on GitHub?
   @Burble what issues are assigned to me?
   @Burble what Jira tickets are assigned to me?
   ```

2. User B connected to different GitHub/Jira accounts gets different answers.
3. Channel responses containing user-scoped data are private/ephemeral.
4. The model never sees or logs OAuth tokens.
5. Tool access is mediated by the provider tool registry, whether execution is
   typed HTTP, MCP-backed, or sandboxed CLI-backed.
6. The orchestrator boundary is JSON-safe and Slack-free.
