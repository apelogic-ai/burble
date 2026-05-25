type GatewayDiagnosticChunk = {
  timestampMs: number;
  text: string;
};

const maxGatewayDiagnosticChunks = 1000;
const chunks: GatewayDiagnosticChunk[] = [];

export function recordGatewayDiagnosticText(text: string, nowMs = Date.now()): void {
  if (!text) {
    return;
  }

  chunks.push({ timestampMs: nowMs, text });
  if (chunks.length > maxGatewayDiagnosticChunks) {
    chunks.splice(0, chunks.length - maxGatewayDiagnosticChunks);
  }
}

export function readGatewayDiagnosticTextSince(timestampMs: number): string {
  return chunks
    .filter((chunk) => chunk.timestampMs >= timestampMs)
    .map((chunk) => chunk.text)
    .join("\n");
}

export function clearGatewayDiagnosticText(): void {
  chunks.length = 0;
}
