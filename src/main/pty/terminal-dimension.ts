/**
 * One terminal dimension as the PTY accepts it: a finite measurement floored into 2..1000,
 * anything else the 80-cell default. The renderer's IPC handler, the one door that sizes a
 * PTY (ADR-050: a mirror only reads), clamps with this before the size reaches the process.
 */
export function terminalDimension(value: number): number {
  if (!Number.isFinite(value)) return 80
  return Math.max(2, Math.min(1000, Math.floor(value)))
}
