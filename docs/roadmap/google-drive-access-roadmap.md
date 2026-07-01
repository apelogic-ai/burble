# Google Drive Access Roadmap

## Context

Burble currently uses a conservative Google Drive model:

- `drive.metadata.readonly` lets Burble search Drive file metadata.
- `drive.file` lets Burble create files and read/write files that are explicitly app-accessible.

Under `drive.file`, app-accessible means files Burble created or files the user explicitly opened/selected for the Burble Google app. It does not grant Burble the same Drive access as the user.

This is the right default for a public or multi-tenant app, but it creates a visible limitation: Burble may find an existing Drive file by metadata and still be unable to read or edit its contents.

## Recommended Default

Keep `drive.file` as the default Google Drive scope.

Add a file grant flow:

1. User asks Burble to edit/read an existing Drive file.
2. If Drive rejects file content access, Burble explains the per-file grant limitation.
3. Burble offers a Google Picker / file-open flow for the user to explicitly grant that file to the app.
4. Burble records the file as app-accessible and can read/edit it on later requests.

This preserves least privilege while making the limitation understandable and recoverable.

## Required Tool Work

- Add Google Picker or equivalent file-open authorization flow.
- Persist app-accessible Drive file grants or recent successful file IDs.
- Add "list files Burble can edit" UX.
- Add native Google Docs API support for Google Docs documents.
- Keep the existing Drive text-file tools for plain text files.

## Optional Broad Drive Mode

For trusted self-hosted or enterprise workspaces, support an explicit broad mode later.

Possible scopes:

- broader Drive read/edit scopes
- Google Docs read/edit scopes

Guardrails:

- disabled by default
- workspace-admin opt-in
- visible in App Home and admin settings
- per-user opt-in if appropriate
- audit every read/write action
- require confirmation for broad writes, sharing, deletes, and destructive edits
- allow workspace policy to disable broad Drive mode entirely

Broad mode should not be silently enabled by reconnecting Google. It changes Burble from "can access files granted to the app" to "can access much of what the principal can access", which materially increases privacy, verification, and blast-radius concerns.

## Open Questions

- Whether Google Picker is enough for native Docs editing under `drive.file`, or whether Docs-specific scopes are also required for reliable document updates.
- Whether app-accessible file grants need an explicit local registry or can be inferred from successful Drive API access.
- Whether scheduled jobs may use app-accessible Drive files without an additional job-scoped confirmation.
