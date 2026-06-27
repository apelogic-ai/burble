export function isRuntimeProgressOnlyMessage(text: string): boolean {
  return (
    /^Starting agent runtime/i.test(text) ||
    /^Agent is /i.test(text) ||
    /^Calling /i.test(text) ||
    isRuntimeControlNotice(text) ||
    /\bFirst-time tip\b.*\binterrupted my current task\b/i.test(text) ||
    /\b\/busy (?:queue|steer|status)\b/i.test(text) ||
    /^_?Final result in /i.test(text) ||
    /completed in \d+(?:ms|s).*\bresult\)/i.test(text)
  );
}

export function isRuntimeProgressOnlyResponseText(text: string): boolean {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.length > 0 && lines.every(isRuntimeProgressOnlyMessage);
}

export function isRuntimeControlNotice(text: string): boolean {
  return (
    isRuntimeInterruptNotice(text) ||
    /\bFirst-time tip\b.*\binterrupted my current task\b/i.test(text) ||
    /\b\/busy (?:queue|steer|status)\b/i.test(text)
  );
}

export function isRuntimeInterruptNotice(text: string): boolean {
  return /^(?::zap:|⚡️?)?\s*Interrupting current task\b/i.test(text.trim());
}

export function runtimeControlNoticeFallbackText(): string {
  return "The agent returned an internal runtime-control notice instead of an answer. Please retry your request.";
}
