import { build } from 'esbuild'
import { copyFile, mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const sourceDirectory = fileURLToPath(
  new URL('../packages/beads-extension', import.meta.url),
)
const staticAssets = ['hvir-extension.json', 'index.html', 'updater.html', 'beads.svg']

export async function prepareBeadsExtension(directory = sourceDirectory): Promise<void> {
  await mkdir(directory, { recursive: true })
  if (resolve(directory) !== resolve(sourceDirectory))
    for (const name of staticAssets)
      await copyFile(join(sourceDirectory, name), join(directory, name))
  for (const [source, output] of [
    ['app', 'beads'],
    ['updater', 'updater'],
  ]) {
    const result = await build({
      entryPoints: [join(sourceDirectory, 'src', `${source}.mjs`)],
      bundle: true,
      platform: 'browser',
      format: 'iife',
      write: false,
      minify: true,
      legalComments: 'none',
      charset: 'utf8',
    })
    await writeFile(join(directory, `${output}.js`), result.outputFiles[0]!.text)
  }
  const styles = await build({
    entryPoints: [join(sourceDirectory, 'src', 'beads.css')],
    bundle: true,
    minify: true,
    legalComments: 'none',
    write: false,
  })
  await writeFile(join(directory, 'beads.css'), styles.outputFiles[0]!.text)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await prepareBeadsExtension()
