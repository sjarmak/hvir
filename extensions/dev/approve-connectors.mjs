import { Buffer } from 'node:buffer'
import { execFileSync } from 'node:child_process'
import console from 'node:console'
import { promises as fs } from 'node:fs'
import process from 'node:process'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

export const LOCAL_HOST = 'local'
export const LIMITS = Object.freeze({ approvals: 256, stateBytes: 256 * 1024 })

export function defaultProfile() {
  return join(homedir(), 'Library', 'Application Support', 'hvir')
}

export function normalizeDeclaration(declaration) {
  return {
    ...(declaration.setup ? { setup: { executable: declaration.setup.executable } } : {}),
    id: declaration.id,
    description: declaration.description,
    context: declaration.context,
    timeoutMs: declaration.timeoutMs,
    outputBytes: declaration.outputBytes,
    environment: [...declaration.environment],
  }
}

function sameKey(entry, installationId, connector, host) {
  return (
    entry.installationId === installationId &&
    entry.connector === connector &&
    entry.host === host
  )
}

export async function canonicalExecutable(path) {
  const canonical = await fs.realpath(path)
  const stat = await fs.stat(canonical)
  if (!stat.isFile() || (stat.mode & 0o111) === 0)
    throw new Error(`${path} is not an executable file`)
  return canonical
}

export function lookupOnLoginPath(basename) {
  const found = execFileSync('/bin/zsh', ['-lc', `command -v -- ${basename}`], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim()
  if (!found.startsWith('/'))
    throw new Error(`${basename} is not on the login shell PATH`)
  return found
}

async function stillExecutable(path) {
  try {
    return await canonicalExecutable(path)
  } catch (reason) {
    if (
      ['ENOENT', 'ENOTDIR'].includes(reason.code) ||
      /not an executable/.test(reason.message)
    )
      return undefined
    throw reason
  }
}

async function selectExecutable(saved, declaration, lookup) {
  const retained = saved && (await stillExecutable(saved.executable))
  if (retained) return { executable: saved.executable, canonical: retained }
  if (!declaration.setup)
    throw new Error(`${declaration.id} declares no executable to look up`)
  const executable = lookup(declaration.setup.executable)
  return { executable, canonical: await canonicalExecutable(executable) }
}

function retainConfiguration(saved, declaration) {
  const env = Object.fromEntries(
    Object.entries(saved?.configuration?.env ?? {})
      .filter(([name]) => declaration.environment.includes(name))
      .sort(([a], [b]) => a.localeCompare(b)),
  )
  return { args: [...(saved?.configuration?.args ?? [])], env }
}

async function readJson(path, fallback) {
  try {
    return JSON.parse(await fs.readFile(path, 'utf8'))
  } catch (reason) {
    if (reason.code === 'ENOENT' && fallback !== undefined) return fallback
    throw reason
  }
}

export async function developmentInstallations(profile) {
  const state = await readJson(join(profile, 'extension-state', 'state.json'))
  const installations = []
  for (const installation of state.installations ?? []) {
    if (installation.kind !== 'development' || installation.enabled === false) continue
    const link = join(profile, 'extensions', installation.source)
    const packageDir = await fs.realpath(link)
    const manifest = await readJson(join(packageDir, 'hvir-extension.json'))
    installations.push({
      installationId: installation.installationId,
      packageId: manifest.id,
      packageDir,
      connectors: (manifest.connectors ?? []).map(normalizeDeclaration),
    })
  }
  return installations
}

export async function planApprovals({
  saved,
  installations,
  lookup = lookupOnLoginPath,
}) {
  const managed = new Set()
  const next = []
  const report = []
  for (const installation of installations) {
    for (const declaration of installation.connectors) {
      const key = [installation.installationId, declaration.id, LOCAL_HOST]
      managed.add(JSON.stringify(key))
      const prior = saved.find((entry) => sameKey(entry, ...key))
      const { executable, canonical } = await selectExecutable(prior, declaration, lookup)
      const approval = {
        installationId: installation.installationId,
        connector: declaration.id,
        host: LOCAL_HOST,
        executable,
        canonicalExecutable: canonical,
        configuration: retainConfiguration(prior, declaration),
        declaration,
      }
      next.push(approval)
      report.push({
        package: installation.packageId,
        connector: declaration.id,
        executable: canonical,
        change: !prior
          ? 'added'
          : JSON.stringify(prior) === JSON.stringify(approval)
            ? 'unchanged'
            : JSON.stringify(prior.declaration) !== JSON.stringify(declaration)
              ? 'declaration-updated'
              : 'executable-updated',
      })
    }
  }
  const retained = saved.filter(
    (entry) =>
      !managed.has(JSON.stringify([entry.installationId, entry.connector, entry.host])) &&
      (entry.host !== LOCAL_HOST ||
        !installations.some((item) => item.installationId === entry.installationId)),
  )
  const approvals = [...retained, ...next]
  const bytes = Buffer.byteLength(JSON.stringify(approvals))
  if (approvals.length > LIMITS.approvals || bytes > LIMITS.stateBytes)
    throw new Error('Connector approval state would exceed hvir bounds')
  const kept = saved.filter(
    (entry) =>
      retained.includes(entry) ||
      managed.has(JSON.stringify([entry.installationId, entry.connector, entry.host])),
  )
  return { approvals, report, dropped: saved.length - kept.length }
}

export function hostRunning(profile) {
  try {
    execFileSync('/usr/bin/pgrep', ['-f', '--', `--user-data-dir=${profile}`], {
      stdio: 'ignore',
    })
    return true
  } catch {
    return false
  }
}

export async function writeJsonFile(target, value) {
  const temp = join(dirname(target), `.${basename(target)}.${process.pid}.tmp`)
  await fs.writeFile(temp, JSON.stringify(value), { mode: 0o644 })
  await fs.rename(temp, target)
  return target
}

export function writeApprovals(profile, approvals) {
  return writeJsonFile(join(profile, 'extension-state', 'connectors.json'), approvals)
}

export async function stamp({ profile, check = false, lookup }) {
  const saved = await readJson(join(profile, 'extension-state', 'connectors.json'), [])
  if (!Array.isArray(saved)) throw new Error('connectors.json is not an approval list')
  const installations = await developmentInstallations(profile)
  const plan = await planApprovals({ saved, installations, lookup })
  if (!check) {
    if (hostRunning(profile))
      throw new Error(
        `hvir is running on ${profile}; quit it first, the store is only read at launch`,
      )
    await writeApprovals(profile, plan.approvals)
  }
  return plan
}

function parseArguments(argv) {
  const options = { profile: defaultProfile(), check: false }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--check') options.check = true
    else if (argument === '--profile') options.profile = argv[++index]
    else throw new Error(`Unknown argument ${argument}`)
  }
  if (!options.profile) throw new Error('--profile needs a directory')
  return options
}

async function main() {
  const options = parseArguments(process.argv.slice(2))
  const plan = await stamp(options)
  for (const row of plan.report)
    console.log(
      `${row.change.padEnd(20)} ${row.package}/${row.connector} -> ${row.executable}`,
    )
  console.log(
    options.check
      ? `check only: ${plan.approvals.length} approvals would be written`
      : `wrote ${plan.approvals.length} approvals to ${options.profile}`,
  )
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch((reason) => {
    console.error(reason instanceof Error ? reason.message : reason)
    process.exit(1)
  })
