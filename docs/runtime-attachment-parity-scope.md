# Runtime Attachment Parity Scope

Status: feature scope. This captures the gap found while testing Slack file
attachments against user-selectable runtimes.

## Problem

Slack can show an attached file in the UI while a selected runtime cannot use
the file content. The app already converts Slack files into sanitized
`ConversationAttachment` metadata and forwards that metadata in the runtime run
request. The gap is runtime-side capability parity:

- OpenClaw has a current-turn attachment fetch path.
- Hermes does not expose attachment metadata or a fetch tool to the model.
- burble-native is also not attachment-capable yet.

The user-visible failure mode is an agent saying that the attached file is not
available even though the user can see it attached to the Slack message.

## Current Matrix

| Layer | Current status |
|---|---|
| Slack file metadata capture | Wired in `buildConversationAttachments` |
| Managed runtime request | Forwards `input.attachments` |
| Tool-group selection | Adds `attachments` when files are present |
| Tool gateway | Exposes `conversation.getAttachment` for current-turn fetches |
| OpenClaw | Lists current request attachments and exposes `conversation.getAttachment` |
| Hermes | Claims `attachments: false`; no prompt section or fetch tool |
| burble-native | Claims `attachments: false`; no fetch tool in the native tool loop |
| Direct AI-SDK runner | Lists attachment metadata, but has no fetch tool equivalent |

## Target Behavior

When a user sends a Slack file with a request, any runtime that advertises
`attachments: true` must be able to:

1. See bounded attachment metadata in the turn context.
2. Know the exact fetch tool and input shape.
3. Fetch only attachments from the current run.
4. Receive text for small text-like files and base64 bytes for supported files.
5. Use the fetched content in the answer or downstream provider workflow.

Runtimes that do not implement this must continue advertising
`attachments: false` and should not be selected for attachment-required turns
once capability gating is enforced.

## Security Constraint

The current gateway path receives attachment metadata in the runtime request
body. The runtime isolation review flags this as too much trust in a runtime:
a compromised runtime could try to submit a forged Slack `externalId`.

Before broadening attachment support beyond OpenClaw, the fetch path should move
to attachment capabilities:

- Store current-run attachment capabilities server-side, or sign opaque
  capability IDs with route, runtime, attachment ID, and expiry.
- Pass only opaque attachment IDs to runtimes.
- On `conversation.getAttachment`, validate the capability against the current
  runtime/run/route before downloading from Slack.
- Never expose Slack private download URLs to runtimes.

This keeps attachment parity from increasing the exfiltration surface.

## Increment 1: Capability-Safe Attachment Fetch

Goal: harden the existing gateway primitive before exposing it to more runtimes.

Work:

- Replace runtime-supplied attachment metadata trust with server-side or signed
  attachment capabilities.
- Keep the public runtime input shape small: attachment ID, name, kind, MIME
  type, size.
- Preserve current OpenClaw behavior through the new capability ID.
- Add negative tests:
  - runtime cannot fetch an attachment not in the current run;
  - runtime cannot forge a Slack `externalId`;
  - runtime A cannot fetch runtime B's attachment;
  - expired capability fails.

Done when:

- Existing OpenClaw attachment tests pass through the capability store/signature.
- Tool gateway no longer trusts runtime-provided Slack file IDs.

## Increment 2: Hermes Attachment Parity

Goal: make Hermes honestly support attachments.

Work:

- Add a Hermes prompt section equivalent to OpenClaw's `Current request
  attachments`.
- Add a Hermes-accessible tool for `conversation.getAttachment`.
- Include the tool hint only when attachments are present or the `attachments`
  group is selected.
- Route the call through the existing runtime-authenticated tool gateway.
- Return fetched text/content to Hermes in the same JSON-result style as other
  Burble bridge tools.
- Flip Hermes capability manifest `attachments` from `false` to `true` only
  after tests prove the path works.

Tests:

- Unit/probe: `build_hermes_turn_text` includes attachment metadata.
- Unit/probe: Hermes exposes/normalizes the attachment fetch tool.
- Tool test: Hermes bridge calls `conversation.getAttachment` with the opaque
  attachment ID and runtime auth.
- Contract/capability assertion: if Hermes claims `attachments: true`, a probe
  run emits/uses an attachment fetch result.

Hand test:

- Select Hermes.
- Send a small `.md` or `.txt` Slack file and ask Burble to summarize/use it.
- Expected: Hermes calls `conversation.getAttachment`, uses returned `text`,
  and does not ask the user to re-upload or paste the file.

## Increment 3: burble-native Attachment Parity

Goal: make the owned SDK runtime the reference implementation for attachment
turns.

Work:

- Include attachment metadata in the native model prompt.
- Add `conversation.getAttachment` to the native scoped tool catalog when
  attachments are present.
- Route fetches through the SDK tool-gateway client.
- Feed fetched text/content back into the tool loop with existing truncation and
  visibility handling.
- Flip burble-native `attachments` to `true` only after tests pass.

Tests:

- Native run request with attachment metadata exposes the fetch tool.
- Model-requested `conversation.getAttachment` returns content into the loop.
- Large text/content is bounded before being fed back to the provider.
- Capability assertion covers `attachments: true`.

## Increment 4: Selection And Fallback

Goal: do not route attachment-required turns to runtimes that cannot handle
attachments.

Work:

- Treat `attachmentCount > 0` as a required runtime capability, not just a tool
  group.
- If the preferred runtime lacks `attachments: true`, either:
  - select another allowed runtime that supports attachments, or
  - show a clear user-facing explanation that the selected runtime cannot use
    attached files.
- Surface the selected/runtime capability reason in logs and App Home details.

Tests:

- Preferred Hermes with `attachments: false` and OpenClaw allowed: selects
  OpenClaw for an attachment turn.
- Only runtimes with `attachments: false`: does not run and returns a clear
  explanation.
- Preferred Hermes after Increment 2: stays on Hermes.

## Non-Goals

- Full multimodal image understanding. This scope covers secure attachment
  fetch and text-like file use first.
- Durable attachment access after the current turn. Attachments are current-run
  capabilities unless a future explicit durable state mechanism is added.
- Browser/web access to Slack file URLs by runtimes.

## Relationship To Provider/Tool Generalization

`conversation.getAttachment` is another example of a runtime bridge tool that
should not require per-runtime hand wiring forever. The long-term shape should
match the provider/tool generalization plan:

- declarative tool spec;
- generated runtime bridge hints;
- generated/coerced input shape;
- capability assertions when a runtime claims support.

For this feature, prioritize correctness and security first, then fold the
attachment tool into the broader bridge-generation work.
