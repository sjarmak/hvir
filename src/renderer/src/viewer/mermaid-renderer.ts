import type { AppTheme } from '../theme'

let requestId = 0
let mermaidPromise: Promise<typeof import('mermaid').default> | undefined

export async function renderMermaid(source: string, theme: AppTheme): Promise<string> {
  mermaidPromise ??= import('mermaid').then(({ default: mermaid }) => mermaid)
  const mermaid = await mermaidPromise
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    theme: theme === 'light' ? 'default' : 'dark',
    suppressErrorRendering: true,
  })
  const { svg } = await mermaid.render(`mermaid-${++requestId}`, source)
  return svg
}

export function resetMermaidRenderer(): void {
  mermaidPromise = undefined
}
