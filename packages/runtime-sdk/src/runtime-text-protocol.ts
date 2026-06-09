export function stripRuntimeToolCallProtocolFragments(text: string): string {
  let output = "";
  let index = 0;
  let removedProtocol = false;

  while (index < text.length) {
    if (text[index] !== "{") {
      output += text[index];
      index += 1;
      continue;
    }

    const end = findJsonObjectEnd(text, index);
    if (end === null) {
      output += text[index];
      index += 1;
      continue;
    }

    const candidate = text.slice(index, end + 1);
    const parsed = parseJsonObject(candidate);
    if (parsed && typeof parsed.tool_call === "object" && parsed.tool_call !== null) {
      removedProtocol = true;
      index = end + 1;
      continue;
    }

    output += candidate;
    index = end + 1;
  }

  return removedProtocol
    ? output
        .replace(/[ \t]+\n/g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim()
    : text;
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
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
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
