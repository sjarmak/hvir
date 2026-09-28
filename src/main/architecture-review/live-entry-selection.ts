import type { HostPath } from '../../shared/host-path'
import type { CaptureEntry } from './capture-entries'
import type { LiveExec } from './live-tree'

const TIMEOUT = 60_000
const SCRIPT = `
while IFS= read -r path; do
  parent=$path
  while [ "\${parent%/*}" != "$parent" ]; do
    parent=\${parent%/*}
    if [ -L "$parent" ]; then printf 'Unsupported symbolic link in scan: %s\\n' "$parent" >&2; exit 1; fi
  done
  if [ ! -L "$path" ] && [ ! -d "$path" ]; then printf '%s\\n' "$path"; fi
done
`

export async function selectLiveEntries(
  exec: LiveExec,
  root: HostPath,
  entries: readonly CaptureEntry[],
  signal: AbortSignal,
): Promise<readonly CaptureEntry[]> {
  if (entries.length === 0) return entries
  for (const { path } of entries)
    if (path.includes('\n') || path.startsWith('"'))
      throw new Error(`Unsupported source path in scan: ${JSON.stringify(path)}`)
  const input = entries.map((entry) => `${entry.path}\n`).join('')
  const result = await exec('sh', ['-c', SCRIPT, 'hvir-architecture-select-live'], {
    cwd: root,
    input,
    signal,
    timeout: TIMEOUT,
    maxBuffer: Buffer.byteLength(input) + 1024,
  })
  if (result.code !== 0)
    throw new Error(`Architecture live selection failed: ${result.stderr.trim()}`)
  const retained = new Set(result.stdout.split('\n').filter(Boolean))
  return entries.filter((entry) => retained.has(entry.path))
}
