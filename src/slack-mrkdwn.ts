export function markdownToSlackMrkdwn(text: string): string {
  let fenceMarker: string | null = null;

  return text
    .split("\n")
    .map((line) => {
      const fence = /^\s*(`{3,}|~{3,})/.exec(line)?.[1] ?? null;
      if (fenceMarker) {
        if (fence?.[0] === fenceMarker[0]) {
          fenceMarker = null;
        }
        return line;
      }
      if (fence) {
        fenceMarker = fence;
        return line;
      }
      return convertMarkdownLine(line);
    })
    .join("\n");
}

function convertMarkdownLine(line: string): string {
  const heading = /^(\s{0,3})#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
  if (heading) {
    const content = stripOuterMarkdownBold(
      convertOutsideInlineCode(heading[2] ?? "")
    );
    return `${heading[1] ?? ""}*${content}*`;
  }
  return convertOutsideInlineCode(line);
}

function convertOutsideInlineCode(line: string): string {
  let output = "";
  let cursor = 0;

  while (cursor < line.length) {
    const codeStart = line.indexOf("`", cursor);
    if (codeStart < 0) {
      return output + convertMarkdownInline(line.slice(cursor));
    }
    output += convertMarkdownInline(line.slice(cursor, codeStart));
    let markerEnd = codeStart;
    while (line[markerEnd] === "`") {
      markerEnd += 1;
    }
    const marker = line.slice(codeStart, markerEnd);
    const codeEnd = line.indexOf(marker, markerEnd);
    if (codeEnd < 0) {
      return output + line.slice(codeStart);
    }
    output += line.slice(codeStart, codeEnd + marker.length);
    cursor = codeEnd + marker.length;
  }

  return output;
}

function convertMarkdownInline(text: string): string {
  return text
    .replace(
      /!?\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)(?:\s+["'][^"']*["'])?\)/g,
      (_match, label: string, url: string) =>
        `<${url}|${label.replace(/\|/g, "-")}>`
    )
    .replace(/\*\*(\S(?:.*?\S)?)\*\*/g, "*$1*")
    .replace(/__(\S(?:.*?\S)?)__/g, "*$1*")
    .replace(/~~(\S(?:.*?\S)?)~~/g, "~$1~");
}

function stripOuterMarkdownBold(text: string): string {
  if (
    (text.startsWith("*") && text.endsWith("*")) ||
    (text.startsWith("_") && text.endsWith("_"))
  ) {
    return text.slice(1, -1);
  }
  return text;
}
