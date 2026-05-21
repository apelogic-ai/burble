export type RuntimeLogger = (message: string) => void;

export function info(message: string): void {
  console.log(`[INFO] ${new Date().toISOString()} ${message}`);
}
