export function deactivateViewerOverlays(ports: {
  readonly deactivateExtensions: () => void
  readonly deactivateReport: () => void
}): void {
  ports.deactivateExtensions()
  ports.deactivateReport()
}
