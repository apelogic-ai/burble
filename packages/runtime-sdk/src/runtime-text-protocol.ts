export function containsRuntimeToolCallProtocolFragments(
  text: string,
): boolean {
  if (containsRuntimeToolProtocolLine(text)) {
    return true;
  }

  let index = 0;
  while (index < text.length) {
    if (text[index] !== "{") {
      index += 1;
      continue;
    }

    const end = findJsonObjectEnd(text, index);
    if (end === null) {
      index += 1;
      continue;
    }

    const candidate = text.slice(index, end + 1);
    const parsed = parseJsonObject(candidate);
    if (
      parsed &&
      typeof parsed.tool_call === "object" &&
      parsed.tool_call !== null
    ) {
      return true;
    }

    index = end + 1;
  }

  return false;
}

export function stripRuntimeToolCallProtocolFragments(text: string): string {
  const transcriptStripped = stripRuntimeToolTranscriptLines(text);
  const source = transcriptStripped.text;
  let output = "";
  let index = 0;
  let removedProtocol = transcriptStripped.removed;

  while (index < source.length) {
    if (source[index] !== "{") {
      output += source[index];
      index += 1;
      continue;
    }

    const end = findJsonObjectEnd(source, index);
    if (end === null) {
      output += source[index];
      index += 1;
      continue;
    }

    const candidate = source.slice(index, end + 1);
    const parsed = parseJsonObject(candidate);
    if (
      parsed &&
      typeof parsed.tool_call === "object" &&
      parsed.tool_call !== null
    ) {
      removedProtocol = true;
      index = end + 1;
      continue;
    }

    output += candidate;
    index = end + 1;
  }

  return removedProtocol ? cleanProtocolStrippedText(output) : text;
}

function containsRuntimeToolProtocolLine(text: string): boolean {
  return text.split(/\r?\n/).some((line) => {
    const value = line.trim();
    return isRuntimeToolProtocolLine(value);
  });
}

function stripRuntimeToolTranscriptLines(text: string): {
  text: string;
  removed: boolean;
} {
  const kept: string[] = [];
  let removed = false;
  let skippingAdjacentPayload = false;

  for (const line of text.split(/\r?\n/)) {
    const value = line.trim();
    if (isRuntimeToolProtocolLine(value)) {
      removed = true;
      skippingAdjacentPayload = true;
      continue;
    }

    if (skippingAdjacentPayload) {
      if (!value) {
        skippingAdjacentPayload = false;
        kept.push(line);
        continue;
      }
      if (value.startsWith("{")) {
        removed = true;
        continue;
      }
      skippingAdjacentPayload = false;
    }

    kept.push(line);
  }

  return removed
    ? { text: kept.join("\n"), removed }
    : { text, removed: false };
}

function isRuntimeToolProtocolLine(value: string): boolean {
  return (
    value.startsWith("to=") ||
    value.startsWith("recipient=") ||
    value.startsWith("<tool") ||
    value.startsWith("</tool>") ||
    isHermesProviderToolMarkerLine(value) ||
    isHermesNativeToolMarkerLine(value)
  );
}

function isHermesProviderToolMarkerLine(value: string): boolean {
  const providerTool =
    "(?:burble_provider_call|(?:github|google|gmail|hubspot|jira|slack|atlassian|scheduled_job|conversation)_[a-z0-9_]+)";
  const explicitProgressMarker = new RegExp(
    `^(?::gear:|⚙️?|gear:)\\s*${providerTool}(?:\\s*(?::|\\(|\\{).*)?$`,
    "i",
  );
  if (explicitProgressMarker.test(value)) {
    return true;
  }

  return new RegExp(`^${providerTool}(?:\\.{3}|…)?$`, "i").test(value);
}

function isHermesNativeToolMarkerLine(value: string): boolean {
  return /^(?::alarm_clock:|⏰)?\s*cronjob\s*:\s*"(?:create|list|run|update|modify|delete|remove|enable|disable)"\s*$/i.test(
    value,
  );
}

function cleanProtocolStrippedText(text: string): string {
  return text
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function findJsonObjectEnd(text: string, start: number): number | null {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < text.length; index += 1) {
    const char = text[index];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }

    if (char === "{") {
      depth += 1;
      continue;
    }

    if (char !== "}") {
      continue;
    }

    depth -= 1;
    if (depth === 0) {
      return index;
    }
  }

  return null;
}

function parseJsonObject(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value);
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
