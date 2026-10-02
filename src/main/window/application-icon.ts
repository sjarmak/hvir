import { join } from 'node:path'

export function developmentApplicationIcon(
  applicationRoot: string,
  platform: NodeJS.Platform,
  rendererUrl: string | undefined,
): string | undefined {
  if (!rendererUrl) return undefined
  return platform === 'darwin'
    ? join(applicationRoot, 'build/icon-macos.png')
    : join(applicationRoot, 'build/icons-linux/512x512.png')
}
