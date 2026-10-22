import { execFileSync } from 'node:child_process'
import console from 'node:console'
import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  defaultProfile,
  hostRunning,
  printReport,
  stamp,
  writeJsonFile,
} from './approve-connectors.mjs'

export function defaultHost() {
  return join(homedir(), 'hvir-worktrees', 'main')
}

export function defaultConfig() {
  return join(dirname(fileURLToPath(import.meta.url)), 'install.json')
}

export async function readConfig(path) {
  const config = JSON.parse(await fs.readFile(path, 'utf8'))
  if (!Array.isArray(config.packages) || config.packages.length === 0)
    throw new Error(`${path} lists no packages`)
  const agentAccess =
    config.agentAccess === undefined
      ? undefined
      : {
          enabled: config.agentAccess.enabled === true,
          confirmDestructive: config.agentAccess.confirmDestructive !== false,
        }
  const packages = config.packages.map((entry) => {
    if (!/^[^/\\.][^/\\]{0,254}$/u.test(entry.source ?? ''))
      throw new Error(`Invalid package source name ${JSON.stringify(entry.source)}`)
    if (typeof entry.path !== 'string') throw new Error(`${entry.source} has no path`)
    return {
      source: entry.source,
      path: resolve(dirname(path), entry.path),
      agentAccess: entry.agentAccess === true,
    }
  })
  const hosts = config.hosts ?? []
  if (!Array.isArray(hosts) || hosts.some((host) => typeof host !== 'string' || !host))
    throw new Error(`${path} hosts must be a list of hvir SSH host names`)
  return { packages, agentAccess, hosts }
}

export async function ensureAgentAccess(profile, agentAccess) {
  if (!agentAccess) return false
  const path = join(profile, 'agent-access.json')
  try {
    await fs.access(path)
    return false
  } catch (reason) {
    if (reason.code !== 'ENOENT') throw reason
  }
  await writeJsonFile(path, agentAccess)
  return true
}

export function validateWithHost(host, packageDir) {
  const output = execFileSync(
    process.execPath,
    [join(host, 'out', 'main', 'agent-cli.js'), 'validate', '--path', packageDir],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  )
  const result = JSON.parse(output)
  if (!result.ok || !/^[a-f0-9]{64}$/u.test(result.validation?.revision ?? ''))
    throw new Error(`${packageDir} failed validation: ${output.trim()}`)
  return { packageId: result.validation.id, revision: result.validation.revision }
}

async function ensureLink(link, target) {
  try {
    const current = await fs.lstat(link)
    if (!current.isSymbolicLink()) throw new Error(`${link} exists and is not a link`)
    const existing = await fs.realpath(link)
    if (existing !== target)
      throw new Error(`${link} points at ${existing}, not ${target}; remove it first`)
    return current
  } catch (reason) {
    if (reason.code !== 'ENOENT') throw reason
  }
  await fs.symlink(target, link)
  return fs.lstat(link)
}

async function retain(profile, target, revision) {
  const destination = join(profile, 'extension-state', 'packages', revision)
  try {
    await fs.access(destination)
    return false
  } catch (reason) {
    if (reason.code !== 'ENOENT') throw reason
  }
  const staging = join(dirname(destination), `.capture-${randomUUID()}`)
  await fs.cp(target, staging, { recursive: true, dereference: false })
  try {
    await fs.rename(staging, destination)
  } catch (reason) {
    await fs.rm(staging, { recursive: true, force: true })
    if (reason.code !== 'EEXIST' && reason.code !== 'ENOTEMPTY') throw reason
  }
  return true
}

async function readState(path) {
  try {
    const state = JSON.parse(await fs.readFile(path, 'utf8'))
    if (!Array.isArray(state.installations) || !Array.isArray(state.removals))
      throw new Error(`${path} is not an installation state file`)
    return state
  } catch (reason) {
    if (reason.code === 'ENOENT') return { installations: [], removals: [] }
    throw reason
  }
}

export async function installPackages({
  profile,
  host,
  packages,
  validate = validateWithHost,
}) {
  const stateDir = join(profile, 'extension-state')
  await fs.mkdir(join(stateDir, 'packages'), { recursive: true })
  await fs.mkdir(join(profile, 'extensions'), { recursive: true })
  const statePath = join(stateDir, 'state.json')
  const state = await readState(statePath)
  const report = []
  const managed = new Set(packages.map((entry) => entry.source))
  const installations = state.installations.filter((entry) => !managed.has(entry.source))
  for (const entry of packages) {
    const target = await fs.realpath(entry.path)
    const link = join(profile, 'extensions', entry.source)
    const linkStat = await ensureLink(link, target)
    const targetStat = await fs.stat(target)
    const { packageId, revision } = validate(host, target)
    const retained = await retain(profile, target, revision)
    const prior =
      state.installations.find((item) => item.source === entry.source) ??
      state.installations.find((item) => item.packageId === packageId)
    const installation = {
      installationId: prior?.installationId ?? randomUUID(),
      packageId,
      source: entry.source,
      sourceIdentity: `${linkStat.dev}:${linkStat.ino}:${targetStat.dev}:${targetStat.ino}`,
      kind: 'development',
      revision,
      enabled: true,
      agentAccess: entry.agentAccess,
    }
    installations.push(installation)
    report.push({
      source: entry.source,
      packageId,
      revision,
      change: !prior
        ? 'installed'
        : JSON.stringify(prior) === JSON.stringify(installation)
          ? 'unchanged'
          : 'updated',
      retained,
    })
  }
  if (new Set(installations.map((item) => item.packageId)).size !== installations.length)
    throw new Error('Two installations would share one package id')
  await writeJsonFile(statePath, { installations, removals: state.removals })
  return { installations, report }
}

export async function provision({
  profile,
  host,
  config,
  lookup,
  validate,
  remoteLookup,
}) {
  const { packages, agentAccess, hosts } = await readConfig(config)
  if (hostRunning(profile))
    throw new Error(
      `hvir is running on ${profile}; quit it first, the state is only read at launch`,
    )
  await fs.mkdir(profile, { recursive: true })
  const agentAccessWritten = await ensureAgentAccess(profile, agentAccess)
  const installed = await installPackages({ profile, host, packages, validate })
  const approvals = await stamp({ profile, lookup, hosts, remoteLookup })
  return { ...installed, approvals, agentAccessWritten }
}

function parseArguments(argv) {
  const options = {
    profile: defaultProfile(),
    host: defaultHost(),
    config: defaultConfig(),
  }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--profile') options.profile = argv[++index]
    else if (argument === '--host') options.host = argv[++index]
    else if (argument === '--config') options.config = argv[++index]
    else throw new Error(`Unknown argument ${argument}`)
  }
  for (const name of ['profile', 'host', 'config'])
    if (!options[name]) throw new Error(`--${name} needs a value`)
  return options
}

async function main() {
  const options = parseArguments(process.argv.slice(2))
  const result = await provision(options)
  for (const row of result.report)
    console.log(
      `${row.change.padEnd(12)} ${row.source} (${row.packageId}) ${row.revision.slice(0, 12)}${row.retained ? ' retained' : ''}`,
    )
  printReport(result.approvals)
  if (result.agentAccessWritten) console.log('agent access enabled for hvir-agent')
  console.log(`provisioned ${options.profile}`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch((reason) => {
    console.error(reason instanceof Error ? reason.message : reason)
    process.exit(1)
  })
