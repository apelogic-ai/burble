export function withUtcTimestamp(message: string, now = new Date()): string {
  return `${now.toISOString()} ${message}`;
}

export function formatLogLine(
  level: "debug" | "info" | "warn" | "error",
  message: string,
  now = new Date()
): string {
  return `[${level.toUpperCase()}] ${withUtcTimestamp(message, now)}`;
}

export function formatLogError(error: unknown, now = new Date()): string {
  if (error instanceof Error) {
    return withUtcTimestamp(error.stack ?? error.message, now);
  }

  return withUtcTimestamp(String(error), now);
}
