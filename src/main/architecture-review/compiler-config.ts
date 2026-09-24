import { posix } from 'node:path'
import ts from 'typescript'
import type { ArchitectureDiagnostic, ArchitectureSourceFile } from '../../shared'

/** Captured files live under this root so TypeScript's absolute-path logic has one base. */
export const VIRTUAL_ROOT = '/__architecture__'
const virtual = (path: string): string => posix.join(VIRTUAL_ROOT, path)
const relative = (path: string): string => posix.relative(VIRTUAL_ROOT, path)

/** TS18003, "No inputs were found": a solution-style root lists no files of its own. */
const NO_INPUTS = 18003
const CONFIG_NAMES = ['tsconfig.json', 'jsconfig.json'] as const

/** Used only when no captured tsconfig or jsconfig governs a source. */
export const FALLBACK_OPTIONS: ts.CompilerOptions = {
  moduleResolution: ts.ModuleResolutionKind.NodeNext,
  module: ts.ModuleKind.NodeNext,
  allowJs: true,
}

export interface CompilerProject {
  /** The governing config's path, or undefined for the fallback options. */
  readonly config: string | undefined
  readonly options: ts.CompilerOptions
}

export interface CompilerSettings {
  readonly projectFor: (path: string) => CompilerProject
  readonly diagnostics: readonly ArchitectureDiagnostic[]
}

interface ParsedProject extends CompilerProject {
  readonly config: string
  readonly fileNames: ReadonlySet<string>
  readonly references: readonly string[]
}

type MatchFiles = (
  path: string,
  extensions: readonly string[] | undefined,
  excludes: readonly string[] | undefined,
  includes: readonly string[] | undefined,
  useCaseSensitiveFileNames: boolean,
  currentDirectory: string,
  depth: number | undefined,
  getFileSystemEntries: (path: string) => {
    readonly files: readonly string[]
    readonly directories: readonly string[]
  },
  realpath: (path: string) => string,
) => string[]

/**
 * Applies the captured tsconfig and jsconfig files the way the TypeScript language service
 * does (ADR-063): a source takes the nearest config above it, or the referenced project of
 * that config which includes it. `extends` and `references` are followed within the capture;
 * one that leaves it is reported as a diagnostic rather than guessed at.
 */
export function loadCompilerSettings(
  configs: readonly ArchitectureSourceFile[],
  sources: readonly string[],
): CompilerSettings {
  const texts = new Map(configs.map((file) => [file.path, file.content]))
  const host = parseHost(texts, [...texts.keys(), ...sources])
  const parsed = new Map<string, ParsedProject>()
  const diagnostics: ArchitectureDiagnostic[] = []
  const project = (config: string): ParsedProject => {
    const known = parsed.get(config)
    if (known) return known
    const result = parseProject(config, texts.get(config) ?? '', host)
    parsed.set(config, result.project)
    diagnostics.push(...result.diagnostics)
    return result.project
  }
  const owners = new Map(sources.map((path) => [path, ownerOf(path, texts, project)]))
  const uncovered = [...owners.values()].filter((owner) => !owner.config).length
  if (uncovered > 0) diagnostics.push(uncoveredDiagnostic(uncovered, sources.length))
  const fallback: CompilerProject = { config: undefined, options: FALLBACK_OPTIONS }
  return {
    projectFor: (path) => owners.get(path) ?? fallback,
    diagnostics,
  }
}

function ownerOf(
  path: string,
  texts: ReadonlyMap<string, string>,
  project: (config: string) => ParsedProject,
): CompilerProject {
  for (let directory = posix.dirname(path); ; directory = posix.dirname(directory)) {
    const config = CONFIG_NAMES.map((name) => posix.join(directory, name)).find((name) =>
      texts.has(name),
    )
    if (config)
      return including(project(config), path, project, new Set()) ?? project(config)
    if (directory === '.') return { config: undefined, options: FALLBACK_OPTIONS }
  }
}

/** The project, or one it references (depth first), whose file list holds `path`. */
function including(
  root: ParsedProject,
  path: string,
  project: (config: string) => ParsedProject,
  visited: Set<string>,
): ParsedProject | undefined {
  if (visited.has(root.config)) return undefined
  visited.add(root.config)
  if (root.fileNames.has(path)) return root
  for (const reference of root.references) {
    const found = including(project(reference), path, project, visited)
    if (found) return found
  }
  return undefined
}

function parseProject(
  config: string,
  text: string,
  host: ts.ParseConfigHost,
): { project: ParsedProject; diagnostics: readonly ArchitectureDiagnostic[] } {
  const json = ts.parseJsonText(virtual(config), text)
  const parsed = ts.parseJsonSourceFileConfigFileContent(
    json,
    host,
    virtual(posix.dirname(config)),
    { allowJs: true },
    virtual(config),
  )
  const references = (parsed.projectReferences ?? [])
    .map((reference) => relative(ts.resolveProjectReferencePath(reference)))
    .filter((reference) => host.fileExists(virtual(reference)))
  const missing = (parsed.projectReferences ?? []).length - references.length
  const errors = [
    ...((json as { readonly parseDiagnostics?: readonly ts.Diagnostic[] })
      .parseDiagnostics ?? []),
    ...parsed.errors,
  ].filter((error) => error.code !== NO_INPUTS)
  return {
    project: {
      config,
      options: parsed.options,
      fileNames: new Set(parsed.fileNames.map(relative)),
      references,
    },
    diagnostics: [
      ...errors.map((error) => configDiagnostic(config, error)),
      ...(missing > 0
        ? [
            {
              file: config,
              line: 1,
              message: `${missing} project reference(s) point outside the captured configs.`,
            },
          ]
        : []),
    ],
  }
}

function configDiagnostic(config: string, error: ts.Diagnostic): ArchitectureDiagnostic {
  const line =
    error.file && error.start !== undefined
      ? error.file.getLineAndCharacterOfPosition(error.start).line + 1
      : 1
  const file = error.file ? relative(error.file.fileName) : config
  return {
    file,
    line,
    message: ts.flattenDiagnosticMessageText(error.messageText, ' '),
  }
}

function uncoveredDiagnostic(uncovered: number, total: number): ArchitectureDiagnostic {
  const message =
    uncovered === total
      ? 'Compiler options are not applied to this scan. Relative imports are resolved from captured files; bare specifiers are classified as external. Aliases and package exports may be unresolved or misclassified.'
      : `Compiler options are not applied to ${uncovered} source file(s) outside every captured tsconfig or jsconfig. Their aliases and package exports may be unresolved or misclassified.`
  return { file: '(capture)', line: 1, message }
}

/** Reads configs and lists directories from the capture alone; nothing touches the disk. */
function parseHost(
  texts: ReadonlyMap<string, string>,
  paths: readonly string[],
): ts.ParseConfigHost {
  const matchFiles = (ts as unknown as { readonly matchFiles?: MatchFiles }).matchFiles
  if (typeof matchFiles !== 'function')
    throw new Error('This TypeScript version cannot expand captured tsconfig includes')
  const entries = directoryEntries(paths)
  const empty = { files: [], directories: [] }
  return {
    useCaseSensitiveFileNames: true,
    fileExists: (path) => texts.has(relative(path)),
    readFile: (path) => texts.get(relative(path)),
    readDirectory: (root, extensions, excludes, includes, depth) =>
      matchFiles(
        root,
        extensions,
        excludes,
        includes,
        true,
        VIRTUAL_ROOT,
        depth,
        (path) => entries.get(relative(path) || '.') ?? empty,
        (path) => path,
      ),
  }
}

function directoryEntries(
  paths: readonly string[],
): ReadonlyMap<string, { files: string[]; directories: string[] }> {
  const entries = new Map<string, { files: string[]; directories: string[] }>()
  const entry = (directory: string) => {
    const known = entries.get(directory)
    if (known) return known
    const created = { files: [], directories: [] }
    entries.set(directory, created)
    if (directory !== '.')
      entry(posix.dirname(directory)).directories.push(posix.basename(directory))
    return created
  }
  for (const path of paths) entry(posix.dirname(path)).files.push(posix.basename(path))
  return entries
}
