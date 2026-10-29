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

function sameDeclaredTool(saved, declaration) {
  return saved?.declaration?.setup?.executable === declaration.setup?.executable
}

async function selectExecutable(saved, declaration, lookup) {
  const retained =
    saved &&
    sameDeclaredTool(saved, declaration) &&
    (await stillExecutable(saved.executable))
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

const REMOTE_SCRIPT = `for a in "$@"; do
  case "$a" in /*) p=$a;; *) p=$("$SHELL" -lc "command -v -- $a" 2>/dev/null | tail -n 1);; esac
  [ -n "$p" ] && [ -f "$p" ] && [ -x "$p" ] || continue
  c=$(readlink -f -- "$p" 2>/dev/null || perl -MCwd=realpath -e 'print realpath(shift)' "$p")
  printf '%s\\t%s\\t%s\\n' "$a" "$p" "$c"
done
`

export function remoteLookupNames(host, requests) {
  const names = [...new Set(requests)]
  for (const name of names)
    if (!/^[A-Za-z0-9/][A-Za-z0-9._/+-]*$/u.test(name))
      throw new Error(`Refusing to look up ${JSON.stringify(name)} on ${host}`)
  return names
}

export function lookupOnRemoteHost(host, requests) {
  const names = remoteLookupNames(host, requests)
  if (names.length === 0) return new Map()
  const output = execFileSync(
    'ssh',
    [
      '-o',
      'BatchMode=yes',
      '-o',
      'ConnectTimeout=8',
      '--',
      host,
      'sh',
      '-s',
      '--',
      ...names,
    ],
    { encoding: 'utf8', input: REMOTE_SCRIPT, stdio: ['pipe', 'pipe', 'pipe'] },
  )
  const found = new Map()
  for (const line of output.split('\n')) {
    const [request, executable, canonical] = line.split('\t')
    if (request && executable?.startsWith('/') && canonical?.startsWith('/'))
      found.set(request, { executable, canonical })
  }
  return found
}

export async function remoteHostsFromProjects(profile) {
  const state = await readJson(join(profile, 'projects.json'), { projects: [] })
  return [
    ...new Set(
      (state.projects ?? [])
        .map((project) => project.hostId)
        .filter((hostId) => typeof hostId === 'string' && hostId !== LOCAL_HOST),
    ),
  ]
}

function remoteRequests(saved, installations, host) {
  const requests = new Set()
  for (const installation of installations)
    for (const declaration of installation.connectors) {
      if (declaration.setup) requests.add(declaration.setup.executable)
      const prior = saved.find((entry) =>
        sameKey(entry, installation.installationId, declaration.id, host),
      )
      if (prior) requests.add(prior.executable)
    }
  return [...requests]
}

export function resolveRemotes({ saved, installations, hosts, remoteLookup }) {
  const remotes = {}
  for (const host of hosts) {
    try {
      remotes[host] = remoteLookup(host, remoteRequests(saved, installations, host))
    } catch (reason) {
      remotes[host] = {
        unreachable: reason instanceof Error ? reason.message : String(reason),
      }
    }
  }
  return remotes
}

function remoteApproval(installation, declaration, host, prior, found) {
  if (declaration.context === 'application') return undefined
  const selected =
    prior && sameDeclaredTool(prior, declaration) && found.get(prior.executable)
  const discovered = declaration.setup && found.get(declaration.setup.executable)
  const target = selected ?? discovered
  if (!target) return undefined
  return {
    installationId: installation.installationId,
    connector: declaration.id,
    host,
    executable: target.executable,
    canonicalExecutable: target.canonical,
    configuration: retainConfiguration(prior, declaration),
    declaration,
  }
}

function describeChange(prior, approval) {
  if (!prior) return 'added'
  if (JSON.stringify(prior) === JSON.stringify(approval)) return 'unchanged'
  if (JSON.stringify(prior.declaration) !== JSON.stringify(approval.declaration))
    return 'declaration-updated'
  return 'executable-updated'
}

export async function planApprovals({
  saved,
  installations,
  lookup = lookupOnLoginPath,
  remotes = {},
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
        host: LOCAL_HOST,
        executable: canonical,
        change: describeChange(prior, approval),
      })
      for (const [host, found] of Object.entries(remotes)) {
        const remoteKey = [installation.installationId, declaration.id, host]
        const remotePrior = saved.find((entry) => sameKey(entry, ...remoteKey))
        const approval =
          found instanceof Map
            ? remoteApproval(installation, declaration, host, remotePrior, found)
            : undefined
        const row = { package: installation.packageId, connector: declaration.id, host }
        if (approval) {
          managed.add(JSON.stringify(remoteKey))
          next.push(approval)
          report.push({
            ...row,
            executable: approval.canonicalExecutable,
            change: describeChange(remotePrior, approval),
          })
        } else if (remotePrior) {
          managed.add(JSON.stringify(remoteKey))
          next.push({ ...remotePrior, declaration })
          report.push({
            ...row,
            executable: remotePrior.canonicalExecutable,
            change: found instanceof Map ? 'kept-missing' : 'kept-unreachable',
          })
        } else {
          report.push({
            ...row,
            executable: '',
            change: found instanceof Map ? 'missing' : 'unreachable',
          })
        }
      }
    }
  }
  const declarationFor = (entry) =>
    installations
      .find((item) => item.installationId === entry.installationId)
      ?.connectors.find((declaration) => declaration.id === entry.connector)
  const retained = saved
    .filter(
      (entry) =>
        !managed.has(
          JSON.stringify([entry.installationId, entry.connector, entry.host]),
        ) &&
        (entry.host !== LOCAL_HOST ||
          !installations.some((item) => item.installationId === entry.installationId)),
    )
    .flatMap((entry) => {
      if (!installations.some((item) => item.installationId === entry.installationId))
        return [entry]
      const declaration = declarationFor(entry)
      return declaration ? [{ ...entry, declaration }] : []
    })
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

export async function stamp({
  profile,
  check = false,
  lookup,
  hosts = [],
  remoteLookup = lookupOnRemoteHost,
}) {
  const saved = await readJson(join(profile, 'extension-state', 'connectors.json'), [])
  if (!Array.isArray(saved)) throw new Error('connectors.json is not an approval list')
  const installations = await developmentInstallations(profile)
  const remoteHosts = [
    ...new Set([...hosts, ...(await remoteHostsFromProjects(profile))]),
  ]
  const remotes = resolveRemotes({
    saved,
    installations,
    hosts: remoteHosts,
    remoteLookup,
  })
  const plan = await planApprovals({ saved, installations, lookup, remotes })
  plan.unreachable = Object.entries(remotes)
    .filter(([, found]) => !(found instanceof Map))
    .map(([host, found]) => `${host}: ${found.unreachable}`)
  if (!check) {
    if (hostRunning(profile))
      throw new Error(
        `hvir is running on ${profile}; quit it first, the store is only read at launch`,
      )
    await writeApprovals(profile, plan.approvals)
  }
  return plan
}

export function printReport(plan) {
  for (const row of plan.report)
    console.log(
      `${row.change.padEnd(20)} ${row.package}/${row.connector} @${row.host} -> ${row.executable}`,
    )
  for (const line of plan.unreachable ?? []) console.log(`unreachable          ${line}`)
}

function parseArguments(argv) {
  const options = { profile: defaultProfile(), check: false, hosts: [] }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--check') options.check = true
    else if (argument === '--profile') options.profile = argv[++index]
    else if (argument === '--remote') options.hosts.push(argv[++index])
    else throw new Error(`Unknown argument ${argument}`)
  }
  if (!options.profile) throw new Error('--profile needs a directory')
  return options
}

async function main() {
  const options = parseArguments(process.argv.slice(2))
  const plan = await stamp(options)
  printReport(plan)
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
