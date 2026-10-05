import SSHConfig from 'ssh-config'

const DEFAULT_SSH_PORT = 22
const MIN_SSH_PORT = 1
const MAX_SSH_PORT = 65_535

export interface SshAliasConfig {
  readonly alias: string
  readonly hostname: string
  readonly user: string
  readonly port: number
  readonly identityFiles: readonly string[]
  readonly identityAgent?: string | null
}

export function parseSshConfig(
  text: string,
  home: string,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): readonly SshAliasConfig[] {
  const parsed = SSHConfig.parse(text)
  const aliases = parsed.flatMap((line): string[] => {
    if (!('param' in line) || !('config' in line)) return []
    const section = line
    if (section.param.toLowerCase() !== 'host') return []
    const value =
      typeof section.value === 'string'
        ? section.value
        : section.value.map((part) => part.val).join(' ')
    return value.split(/\s+/).filter((alias) => alias && !/[*?]/.test(alias))
  })
  return [...new Set(aliases)].map((alias) => {
    const values = parsed.compute(alias, { ignoreCase: true, matchExec: false })
    const one = (value: string | string[] | undefined): string | undefined =>
      Array.isArray(value) ? value[0] : value
    const hostname = one(values['hostname']) ?? alias
    const localUser = environment['USER'] ?? process.env['USER'] ?? 'unknown'
    const user = one(values['user']) ?? localUser
    const configuredPort = one(values['port']) ?? String(DEFAULT_SSH_PORT)
    const rawPort = /^\d+$/.test(configuredPort) ? Number(configuredPort) : Number.NaN
    const port =
      Number.isInteger(rawPort) && rawPort >= MIN_SSH_PORT && rawPort <= MAX_SSH_PORT
        ? rawPort
        : DEFAULT_SSH_PORT
    const rawIdentity = values['identityfile']
    const identityFiles = (
      Array.isArray(rawIdentity) ? rawIdentity : rawIdentity ? [rawIdentity] : []
    ).map((path) => expandSshValue(path, home, hostname, user, localUser, port))
    const rawIdentityAgent = one(values['identityagent'])
    const identityAgent = resolveIdentityAgent(
      rawIdentityAgent,
      home,
      hostname,
      user,
      localUser,
      port,
      environment,
    )
    return {
      alias,
      hostname,
      user,
      port,
      identityFiles,
      ...(identityAgent === undefined ? {} : { identityAgent }),
    }
  })
}

function resolveIdentityAgent(
  value: string | undefined,
  home: string,
  hostname: string,
  user: string,
  localUser: string,
  port: number,
  environment: Readonly<Record<string, string | undefined>>,
): string | null | undefined {
  if (value === undefined) return undefined
  if (value === 'none') return null
  if (value === 'SSH_AUTH_SOCK') return ownEnvironmentValue(environment, 'SSH_AUTH_SOCK') ?? null
  const variable = value.match(
    /^\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))$/,
  )
  const variableName = variable?.[1] ?? variable?.[2]
  if (variableName) return ownEnvironmentValue(environment, variableName) ?? null
  const variables = [...value.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g)]
  if (variables.some((match) => ownEnvironmentValue(environment, match[1]!) === undefined)) {
    return null
  }
  return expandSshValue(value, home, hostname, user, localUser, port, environment)
}

function ownEnvironmentValue(
  environment: Readonly<Record<string, string | undefined>>,
  name: string,
): string | undefined {
  return Object.hasOwn(environment, name) ? environment[name] : undefined
}

function expandSshValue(
  value: string,
  home: string,
  hostname: string,
  user: string,
  localUser: string,
  port: number,
  environment?: Readonly<Record<string, string | undefined>>,
): string {
  const tokens = {
    '%': '%',
    d: home,
    h: hostname,
    r: user,
    u: localUser,
    p: String(port),
  } as const
  const expansionPattern =
    environment === undefined
      ? /%([%dhrup])/g
      : /%([%dhrup])|\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g
  return value
    .replace(/^~(?=\/|$)/, home)
    .replace(
      expansionPattern,
      (_match, token: keyof typeof tokens | undefined, name: string | undefined) => {
        if (token !== undefined) return tokens[token]
        if (name === undefined || environment === undefined) {
          throw new Error('Invalid SSH value expansion')
        }
        const replacement = ownEnvironmentValue(environment, name)
        if (replacement === undefined) {
          throw new Error(`Missing SSH environment variable ${name}`)
        }
        return replacement
      },
    )
}
