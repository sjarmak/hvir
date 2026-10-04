import SSHConfig from 'ssh-config'

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
    const user = one(values['user']) ?? process.env['USER'] ?? 'unknown'
    const rawPort = Number.parseInt(one(values['port']) ?? '22', 10)
    const rawIdentity = values['identityfile']
    const identityFiles = (
      Array.isArray(rawIdentity) ? rawIdentity : rawIdentity ? [rawIdentity] : []
    ).map((path) => expandSshValue(path, home, hostname, user))
    const rawIdentityAgent = one(values['identityagent'])
    const identityAgent = resolveIdentityAgent(
      rawIdentityAgent,
      home,
      hostname,
      user,
      environment,
    )
    return {
      alias,
      hostname,
      user,
      port: Number.isFinite(rawPort) ? rawPort : 22,
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
  environment: Readonly<Record<string, string | undefined>>,
): string | null | undefined {
  if (value === undefined) return undefined
  if (value.toLowerCase() === 'none') return null
  if (value === 'SSH_AUTH_SOCK') return environment['SSH_AUTH_SOCK'] ?? null
  const variable = value.match(/^\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))$/)
  const variableName = variable?.[1] ?? variable?.[2]
  if (variableName) return environment[variableName] ?? null
  const variables = [...value.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g)]
  if (variables.some((match) => environment[match[1]!] === undefined)) return null
  const expandedEnvironment = value.replace(
    /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g,
    (_match, name: string) => environment[name]!,
  )
  return expandSshValue(expandedEnvironment, home, hostname, user)
}

function expandSshValue(
  value: string,
  home: string,
  hostname: string,
  user: string,
): string {
  return value
    .replace(/^~(?=\/|$)/, home)
    .replaceAll('%d', home)
    .replaceAll('%h', hostname)
    .replaceAll('%r', user)
    .replaceAll('%%', '%')
}
