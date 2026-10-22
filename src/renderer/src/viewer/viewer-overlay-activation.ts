interface ViewerOverlayPorts {
  readonly deactivateExtensions: () => void
  readonly deactivateReport: () => void
}

export function activateViewerOverlay(
  surface: 'architecture' | 'web',
  ports: ViewerOverlayPorts,
): void {
  void surface
  ports.deactivateExtensions()
  ports.deactivateReport()
}
