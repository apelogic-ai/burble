# Observability And Accounting

Burble emits structured JSONL events for conversation turns, runtime runs,
tool gateway calls, runtime heartbeats, and model usage/accounting metadata.

## Local Event Storage

The default deploy path is partitioned JSONL:

```text
/data/observability/events/
  native/
    year=YYYY/
      month=MM/
        day=DD/
          hour=HH/
            workspace=<workspace-id>/
              runtime=<runtime-type>/
                events.jsonl
```

This follows the storage shape used by the sibling `observer` project: small
append-only JSONL partitions are easier to scan, archive, compact, and delete
than one global file. Partitioning is UTC and uses sanitized path segments.

When directory-based logging is enabled, Burble also writes an
Observer-compatible normalized projection:

```text
/data/observability/events/
  observer-normalized/
    YYYY-MM-DD/
      <runtime-type>/
        <session-id>.jsonl
```

Those rows follow Observer's local dashboard trace-entry shape closely enough
for session/tool/token analysis: `message`, `tool_call`, `tool_result`,
`task_summary`, and `token_usage` entries include stable IDs, timestamps,
agent/runtime name, session ID, project/workspace, developer/principal,
tool metadata, durations, success flags, and token usage. Runtime heartbeats
are intentionally excluded from this projection so they do not create noisy
fake sessions.

`OBSERVABILITY_JSONL_PATH` remains as a compatibility fallback for a single
JSONL file. If both `OBSERVABILITY_JSONL_DIR` and `OBSERVABILITY_JSONL_PATH`
are set, directory logging wins so deploys can safely leave an old path value
in the environment while moving to partitioned storage.

## Content Policy

The default is metadata-only:

```text
OBSERVABILITY_INCLUDE_CONTENT=false
```

Sensitive key names such as `token`, `secret`, `authorization`, `cookie`,
`password`, `jwt`, `oauth`, and `credential` are redacted recursively.

Content fields are only persisted when explicitly enabled. Even then, sensitive
key names are still redacted.

## Token Accounting

Token accounting comes from two sources:

- Exact provider usage, stored on events as `usage` when the runtime or local
  model provider returns exact token counts.
- Runtime telemetry, stored under `attributes.telemetry`, including prompt
  character estimates, approximate tokens, model transport diagnostics, and
  phase timings when exact usage is unavailable.

For reporting, exact `usage.totalTokens` should win. When exact usage is absent,
dashboards can fall back to telemetry estimates and label them as estimates.

## What We Borrowed From Observer

Observer has a more complete pipeline:

- local normalized JSONL partitions;
- HTTP shipping into a central ingestor;
- immutable batch metadata and dedup markers;
- disclosure levels for local-only vs shipped data;
- dashboard ingestion into SQLite for session/tool/token analysis.

Burble’s current PR implements structured native event emission, partitioned
local JSONL, and an Observer-compatible normalized local projection. The next
useful follow-up is a reader/rollup layer that can scan partitions and produce
queryable per-workspace, per-principal, per-runtime, per-session, and per-job
aggregates.

## Future Follow-Ups

- Add an observability reader that recursively scans partitions.
- Add rollup tables or derived JSONL for token totals, latency, tool calls, and
  error rates.
- Add an optional HTTP shipper to an Observer-compatible ingestor.
- Add retention and compaction policy per workspace/runtime/date partition.
- Add disclosure tiers if Burble starts persisting prompt or tool-result
  content outside local-only debugging.
