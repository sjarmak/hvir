import { expect, it } from 'vitest'
import { readModuleImports } from '../src/main/architecture-review/module-imports'
import { TYPESCRIPT_ONLY_SCANNERS } from '../src/main/architecture-review/typescript-scanner'
import { gitBlobId } from '../src/main/architecture-review/blob-id'
import { localPath } from '../src/shared/host-path'

const source = (path: string, content: string) => ({
  path,
  content,
  object: gitBlobId(Buffer.from(content)),
})

it('reads each source module once by blob and reports what no scanner reads as null', async () => {
  const a = source('src/a.ts', "import { b } from './b'\nimport type { T } from './t'\n")
  const same = source('src/copy.ts', a.content)
  const other = source('src/other.py', 'import os\n')
  const result = await readModuleImports(
    [a, same, other],
    localPath('/repo'),
    undefined,
    TYPESCRIPT_ONLY_SCANNERS,
  )
  expect(result.scanners).toContain(TYPESCRIPT_ONLY_SCANNERS.scanners[0]!.version)
  expect(result.imports).toEqual([
    {
      object: a.object,
      imports: [
        { specifier: './b', form: 'import', typeOnly: false },
        { specifier: './t', form: 'import', typeOnly: true },
      ],
    },
    { object: other.object, imports: null },
  ])
})
