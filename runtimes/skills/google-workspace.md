---
id: google-workspace
version: "1"
toolGroups: [google]
---
# Google Workspace Workflow Skill

Use the available provider tools as atomic operations. For capabilities not
covered by a first-class tool, discover the live operation catalog and call an
exact advertised operation with arguments matching its schema. Do not invent
operation names or argument shapes.

Reuse concrete resource IDs already present in the current request or recent
conversation. If a resource ID is known, reuse it instead of searching again.
Search only when no reliable identifier is available or when the user asks for
a search.

When the user asks to duplicate an existing file and preserve formatting,
copy the source file before editing the copy. Do not substitute creation from
plain text for a copy. Read enough source content or metadata to identify the
exact values that need changing, then apply the smallest atomic edits to the
copied resource.

Resolve relative dates from the authoritative current time in the runtime
context and the user's stated period. Infer a cadence from the source only when
the evidence is unambiguous; otherwise ask one concise clarification. Never
invent dates from stale examples or model knowledge.

For corrections, update the artifact created earlier in the conversation when
it is identifiable. Do not create another artifact unless the user asks for a
new one or the existing artifact cannot be safely corrected.

Inspect operation results for the requested effects. Do not claim completion
when a required operation failed, an edit matched zero targets, or the final
artifact was not verified. State the specific unresolved effect instead.
