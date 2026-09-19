/**
 * One terminal dimension as the PTY accepts it: a finite measurement floored into 2..1000,
 * anything else the 80-cell default. Both doors that size a PTY, the renderer's IPC handler
 * and a mirror lease (ADR-052), clamp with this before the size reaches the process.
 */
export function terminalDimension(value: number): number {
  if (!Number.isFinite(value)) return 80
  return Math.max(2, Math.min(1000, Math.floor(value)))
}
