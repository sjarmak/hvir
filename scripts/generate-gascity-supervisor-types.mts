/**
 * Pins TypeScript types for the exact Gas City supervisor operations hvir calls.
 *
 * The supervisor's OpenAPI document describes its whole verb set, including every
 * session mutation ADR-047 refuses. This generator reads that document and emits
 * only the transitive schema closure of the declared operations below, so the
 * generated type surface cannot express a call hvir has decided not to make.
 *
 *   npm run generate:gascity-supervisor-types
 *   npm run generate:gascity-supervisor-types -- --endpoint 127.0.0.1:8372
 *
 * A running supervisor serves the document; nothing here reads a credential, and
 * the fetched document is never written to the repository.
 */
import { createHash } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url))

/** gc's documented loopback default. ADR-047 declares the endpoint; it never scans. */
export const SUPERVISOR_DEFAULT_ENDPOINT = '127.0.0.1:8372'

/** One entry per operation hvir is allowed to call. Adding one is a decision. */
export const SUPERVISOR_OPERATIONS = [
  { name: 'health', method: 'GET', path: '/health', operationId: 'get-health' },
  { name: 'cities', method: 'GET', path: '/v0/cities', operationId: 'get-v0-cities' },
  {
    name: 'sessions',
    method: 'GET',
    path: '/v0/city/{cityName}/sessions',
    operationId: 'get-v0-city-by-city-name-sessions',
  },
  {
    name: 'cityPending',
    method: 'GET',
    path: '/v0/city/{cityName}/pending',
    operationId: 'get-v0-city-by-city-name-pending',
  },
  {
    name: 'sessionPending',
    method: 'GET',
    path: '/v0/city/{cityName}/session/{id}/pending',
    operationId: 'get-v0-city-by-city-name-session-by-id-pending',
  },
  {
    name: 'transcript',
    method: 'GET',
    path: '/v0/city/{cityName}/session/{id}/transcript',
    operationId: 'get-v0-city-by-city-name-session-by-id-transcript',
  },
  {
    name: 'sessionStream',
    method: 'GET',
    path: '/v0/city/{cityName}/session/{id}/stream',
    operationId: 'stream-session',
  },
  {
    name: 'cityEvents',
    method: 'GET',
    path: '/v0/city/{cityName}/events/stream',
    operationId: 'stream-events',
  },
  {
    name: 'respond',
    method: 'POST',
    path: '/v0/city/{cityName}/session/{id}/respond',
    operationId: 'respond-session',
  },
  {
    name: 'submit',
    method: 'POST',
    path: '/v0/city/{cityName}/session/{id}/submit',
    operationId: 'submit-session',
  },
] as const

/**
 * Schema roots the closure starts from. The response and request schemas of the
 * declared operations are found in the document; these are the server-sent event
 * payloads, which the document nests inside a `text/event-stream` example rather
 * than naming as an operation response.
 */
const EVENT_ROOTS = [
  'SessionStreamStructuredMessageEvent',
  'SessionActivityEvent',
  'SessionPendingClearedEvent',
  'HeartbeatEvent',
  // The city event stream's declared vocabulary: the six session lifecycle
  // transitions hvir reports, named one by one rather than taken as the union.
  'TypedEventStreamEnvelopeSessionCrashed',
  'TypedEventStreamEnvelopeSessionStopped',
  'TypedEventStreamEnvelopeSessionSuspended',
  'TypedEventStreamEnvelopeSessionWoke',
  'TypedEventStreamEnvelopeSessionIdleKilled',
  'TypedEventStreamEnvelopeSessionQuarantined',
]

/**
 * Excluded on purpose, with the decision each exclusion carries:
 * the raw branch is provider-native transcript content ADR-046 keeps out of hvir,
 * and it is reachable only by asking for `format=raw`, which the client never sends.
 * Excluding the types means a later caller cannot quietly start asking for it.
 */
const EXCLUDED_SCHEMAS = new Set([
  'SessionTranscriptRawResponse',
  'SessionRawMessageFrame',
  'SessionStreamRawMessageEvent',
  // The city event stream's whole envelope union: ninety-odd variants covering
  // mail, beads, storage, workflows, and supervisor administration. hvir reads
  // the six session lifecycle variants named in EVENT_ROOTS and reports every
  // other type as unrecognized, so generating the union would only make it
  // expressible to consume an event this build has not decided to handle.
  'TypedEventStreamEnvelope',
])

const TOOL_PAYLOADS = new Set([
  'SessionStructuredArgument',
  'SessionStructuredPatchHunk',
  'SessionStructuredPlanStep',
  'SessionStructuredQuestion',
  'SessionStructuredQuestionOption',
  'SessionStructuredSearchResultItem',
  'SessionStructuredTodoItem',
  'SessionStructuredToolError',
  'SessionStructuredUploadedFile',
])

/**
 * One file per group, declared in dependency order: a group may reference a later
 * group and never an earlier one. The split exists so no generated file crowds the
 * source budget of the hand-maintained modules beside it.
 */
const GROUPS = [
  {
    name: 'api',
    owns: (name: string) => !isTranscriptSchema(name) && !isToolSchema(name),
  },
  {
    name: 'transcript',
    owns: (name: string) => isTranscriptSchema(name) && !isToolSchema(name),
  },
  { name: 'tools', owns: isToolSchema },
] as const

/** The tool call and tool result payload variants, most of the structured closure. */
function isToolSchema(name: string): boolean {
  return (
    name.startsWith('SessionStructuredTool') ||
    name.startsWith('SessionStructuredToolResult') ||
    TOOL_PAYLOADS.has(name)
  )
}

function isTranscriptSchema(name: string): boolean {
  return (
    name.startsWith('SessionStructured') ||
    name.startsWith('SessionTranscript') ||
    name === 'PaginationInfo' ||
    name === 'OutputTurn'
  )
}

function moduleName(group: string): string {
  return `./generated-supervisor-${group}`
}

function outputPath(group: string): string {
  return resolve(SCRIPT_DIRECTORY, `../src/main/gascity/generated-supervisor-${group}.ts`)
}

interface JsonSchema {
  readonly $ref?: string
  readonly type?: string | readonly string[]
  readonly properties?: Readonly<Record<string, JsonSchema>>
  readonly required?: readonly string[]
  readonly additionalProperties?: boolean | JsonSchema
  readonly items?: JsonSchema
  readonly oneOf?: readonly JsonSchema[]
  readonly enum?: readonly unknown[]
  readonly const?: unknown
  readonly description?: string
  readonly title?: string
}

interface OpenApiDocument {
  readonly info: { readonly title: string; readonly version: string }
  readonly paths: Readonly<
    Record<string, Readonly<Record<string, { readonly operationId?: string }>>>
  >
  readonly components: { readonly schemas: Readonly<Record<string, JsonSchema>> }
}

const SCHEMA_REF = '#/components/schemas/'

function refName(ref: string): string {
  if (!ref.startsWith(SCHEMA_REF)) throw new Error(`Unreadable schema reference: ${ref}`)
  return ref.slice(SCHEMA_REF.length)
}

function collectReferences(node: unknown, found: string[]): void {
  if (Array.isArray(node)) {
    for (const value of node) collectReferences(value, found)
    return
  }
  if (!node || typeof node !== 'object') return
  for (const [key, value] of Object.entries(node)) {
    // A discriminator mapping repeats references the oneOf branches already carry.
    if (key === 'discriminator') continue
    // A response header component is a document reference, not a payload schema.
    if (key === '$ref' && typeof value === 'string') {
      if (value.startsWith(SCHEMA_REF)) found.push(refName(value))
    } else collectReferences(value, found)
  }
}

/** Every schema the declared operations can actually return or send, and nothing else. */
function schemaClosure(document: OpenApiDocument): string[] {
  const schemas = document.components.schemas
  const queue: string[] = []
  for (const operation of SUPERVISOR_OPERATIONS) {
    const method = document.paths[operation.path]?.[operation.method.toLowerCase()]
    if (!method) throw new Error(`Supervisor no longer serves ${operation.path}`)
    if (method.operationId !== operation.operationId)
      throw new Error(
        `Operation identity changed for ${operation.path}: ${String(method.operationId)}`,
      )
    collectReferences(method, queue)
  }
  queue.push(...EVENT_ROOTS)
  const ordered: string[] = []
  const seen = new Set<string>()
  while (queue.length) {
    const name = queue.shift()
    if (!name || seen.has(name) || EXCLUDED_SCHEMAS.has(name)) continue
    const schema = schemas[name]
    if (!schema) throw new Error(`Supervisor document omits schema ${name}`)
    seen.add(name)
    ordered.push(name)
    collectReferences(schema, queue)
  }
  return ordered.filter((name) => !EXCLUDED_SCHEMAS.has(name)).sort()
}

function literal(value: unknown): string {
  if (typeof value === 'string') return `'${value.replace(/'/g, "\\'")}'`
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  throw new Error(`Unsupported literal in supervisor schema: ${String(value)}`)
}

function nullableTypes(type: string | readonly string[] | undefined): {
  readonly base: string | undefined
  readonly nullable: boolean
} {
  if (type === undefined) return { base: undefined, nullable: false }
  if (typeof type === 'string') return { base: type, nullable: false }
  const base = type.filter((entry) => entry !== 'null')
  if (base.length !== 1) throw new Error(`Unsupported type union: ${type.join('|')}`)
  return { base: base[0], nullable: type.includes('null') }
}

function typeExpression(schema: JsonSchema, owner: string): string {
  if (schema.$ref) return refName(schema.$ref)
  if (schema.oneOf) {
    // An excluded branch leaves the union, so no caller can name the shape hvir
    // decided not to request even though the server can still produce it.
    const branches = schema.oneOf.filter(
      (one) => !(one.$ref && EXCLUDED_SCHEMAS.has(refName(one.$ref))),
    )
    if (!branches.length) throw new Error(`Every branch of ${owner} is excluded`)
    return branches.map((one) => typeExpression(one, owner)).join(' | ')
  }
  if (schema.const !== undefined) return literal(schema.const)
  if (schema.enum) return schema.enum.map(literal).join(' | ')
  const { base, nullable } = nullableTypes(schema.type)
  const suffix = nullable ? ' | null' : ''
  // A schema that constrains nothing describes arbitrary JSON; narrowing stays the
  // caller's job rather than becoming an invented shape here.
  if (base === undefined) return 'unknown'
  switch (base) {
    case 'string':
      return `string${suffix}`
    case 'integer':
    case 'number':
      return `number${suffix}`
    case 'boolean':
      return `boolean${suffix}`
    case 'array': {
      if (!schema.items) throw new Error(`Array without items in ${owner}`)
      return `readonly ${wrap(typeExpression(schema.items, owner))}[]${suffix}`
    }
    case 'object': {
      if (schema.properties) throw new Error(`Inline object properties in ${owner}`)
      const value =
        typeof schema.additionalProperties === 'object'
          ? typeExpression(schema.additionalProperties, owner)
          : 'unknown'
      return `Readonly<Record<string, ${value}>>${suffix}`
    }
    default:
      throw new Error(`Unsupported schema type in ${owner}: ${String(base)}`)
  }
}

function wrap(expression: string): string {
  return /[|&]/.test(expression) ? `(${expression})` : expression
}

/** Wrapped, because an upstream description is often a paragraph on one line. */
function documentation(schema: JsonSchema, indent: string): string {
  const text = schema.description?.replace(/\s+/g, ' ').trim()
  if (!text) return ''
  const single = `${indent}/** ${text} */`
  if (single.length <= 88) return `${single}\n`
  const width = 85 - indent.length
  const lines: string[] = []
  let current = ''
  for (const word of text.split(' ')) {
    if (current && `${current} ${word}`.length > width) {
      lines.push(current)
      current = word
    } else current = current ? `${current} ${word}` : word
  }
  if (current) lines.push(current)
  return `${indent}/**\n${lines.map((line) => `${indent} * ${line}`).join('\n')}\n${indent} */\n`
}

function declaration(name: string, schema: JsonSchema): string {
  const header = documentation(schema, '')
  if (schema.properties) {
    const required = new Set(schema.required ?? [])
    const fields = Object.entries(schema.properties)
      .map(([field, property]) => {
        const optional = required.has(field) ? '' : '?'
        const key = /^[A-Za-z_][A-Za-z0-9_]*$/.test(field) ? field : `'${field}'`
        return `${documentation(property, '  ')}  readonly ${key}${optional}: ${typeExpression(property, name)}\n`
      })
      .join('')
    return `${header}export interface ${name} {\n${fields}}\n`
  }
  return `${header}export type ${name} = ${typeExpression(schema, name)}\n`
}

function operationTable(): string {
  const rows = SUPERVISOR_OPERATIONS.map(
    (operation) =>
      `  ${operation.name}: { method: '${operation.method}', path: '${operation.path}' },`,
  ).join('\n')
  return [
    '/** The exact request line of every operation hvir may call. */',
    'export const GASCITY_SUPERVISOR_OPERATIONS = {',
    rows,
    '} as const\n',
  ].join('\n')
}

function fileHeader(source: string): string {
  return [
    `/* This file is generated by ${source}. Do not edit it by hand. */`,
    '/* Regenerate with: npm run generate:gascity-supervisor-types */',
    '',
  ].join('\n')
}

function provenance(document: OpenApiDocument, digest: string): string {
  const names = SUPERVISOR_OPERATIONS.map((operation) => `'${operation.name}'`).join(', ')
  return [
    '/** Identity of the document these types were read from. */',
    'export const GASCITY_SUPERVISOR_API_PROVENANCE = {',
    `  title: ${literal(document.info.title)},`,
    `  specVersion: ${literal(document.info.version)},`,
    `  specSha256: '${digest}',`,
    `  defaultEndpoint: '${SUPERVISOR_DEFAULT_ENDPOINT}',`,
    `  operations: [${names}],`,
    '} as const\n',
  ].join('\n')
}

function endpointArgument(argv: readonly string[]): string {
  const index = argv.indexOf('--endpoint')
  if (index < 0) return SUPERVISOR_DEFAULT_ENDPOINT
  const value = argv[index + 1]
  if (!value) throw new Error('--endpoint requires an authority such as 127.0.0.1:8372')
  return value
}

async function main(): Promise<void> {
  const endpoint = endpointArgument(process.argv.slice(2))
  const response = await fetch(`http://${endpoint}/openapi.json`)
  if (!response.ok)
    throw new Error(`Supervisor document unavailable (${response.status}) at ${endpoint}`)
  const body = Buffer.from(await response.arrayBuffer())
  const digest = createHash('sha256').update(body).digest('hex')
  const document = JSON.parse(body.toString('utf8')) as OpenApiDocument
  const closure = schemaClosure(document)
  const source = 'scripts/generate-gascity-supervisor-types.mts'

  const owners = new Map<string, string>()
  for (const name of closure) {
    const group = GROUPS.find((candidate) => candidate.owns(name))
    if (!group) throw new Error(`No generated file owns schema ${name}`)
    owners.set(name, group.name)
  }
  const referencesOf = (name: string): readonly string[] => {
    const found: string[] = []
    collectReferences(document.components.schemas[name], found)
    return found.filter((reference) => owners.has(reference))
  }

  for (const [index, group] of GROUPS.entries()) {
    const owned = closure.filter((name) => owners.get(name) === group.name)
    if (!owned.length) continue
    // Later groups only: a reference pointing backwards would be an import cycle.
    const imports = new Map<string, string[]>()
    for (const name of owned) {
      for (const reference of referencesOf(name)) {
        const target = owners.get(reference)!
        if (target === group.name) continue
        const position = GROUPS.findIndex((candidate) => candidate.name === target)
        if (position < index)
          throw new Error(`Generated ${group.name} cannot depend on ${target}`)
        const module = moduleName(GROUPS[position]!.name)
        const existing = imports.get(module) ?? []
        if (!existing.includes(reference)) existing.push(reference)
        imports.set(module, existing)
      }
    }
    const imported = [...imports.entries()].map(([module, names]) => {
      const sorted = [...names].sort()
      const list = sorted.map((name) => `  ${name},`).join('\n')
      return `import type {\n${list}\n} from '${module}'\nexport type { ${sorted.join(', ')} }\n`
    })
    const preamble =
      group.name === 'api' ? `${provenance(document, digest)}\n${operationTable()}\n` : ''
    const body = owned
      .map((name) => declaration(name, document.components.schemas[name]!))
      .join('\n')
    await writeFile(
      outputPath(group.name),
      `${fileHeader(source)}\n${imported.join('\n')}${imported.length ? '\n' : ''}${preamble}${body}`,
      'utf8',
    )
  }

  process.stdout.write(
    `Generated ${closure.length} types from ${document.info.title} ${document.info.version}\n`,
  )
}

await main()
