function isObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function readJobIdCandidate(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readNestedJobId(value) {
  if (!isObject(value)) {
    return undefined;
  }
  return (
    readJobIdCandidate(value.jobId) ??
    readJobIdCandidate(value.job_id) ??
    readJobIdCandidate(value.id)
  );
}

export function extractBurbleJobId(ctx) {
  const candidates = [
    readJobIdCandidate(ctx?.jobId),
    readJobIdCandidate(ctx?.job_id),
    readNestedJobId(ctx?.scheduledJob),
    readNestedJobId(ctx?.scheduled_job),
    readNestedJobId(ctx?.scheduled),
    readNestedJobId(ctx?.scheduler),
    readNestedJobId(ctx?.job),
    readNestedJobId(ctx?.cron),
    readNestedJobId(ctx?.run),
    readNestedJobId(ctx?.task),
    readNestedJobId(ctx?.delivery),
    readNestedJobId(ctx?.origin),
    readNestedJobId(ctx?.context),
    readNestedJobId(ctx?.identity)
  ];
  for (const candidate of candidates) {
    if (candidate) {
      return candidate;
    }
  }
  return undefined;
}

export function summarizeBurbleJobIdContext(ctx) {
  if (!isObject(ctx)) {
    return "ctx=non_object";
  }
  const keys = Object.keys(ctx).sort().join(",");
  const nested = [
    "scheduledJob",
    "scheduled_job",
    "scheduled",
    "scheduler",
    "job",
    "cron",
    "run",
    "task",
    "delivery",
    "origin",
    "context",
    "identity"
  ]
    .map((key) =>
      isObject(ctx[key]) ? `${key}=[${Object.keys(ctx[key]).sort().join(",")}]` : null
    )
    .filter(Boolean)
    .join(" ");
  return `${nested ? `${nested} ` : ""}ctxKeys=[${keys}]`;
}
