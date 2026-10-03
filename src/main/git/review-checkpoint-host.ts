import { createHash } from 'node:crypto'
import {
  boundTextWorkload,
  DIFF_INPUT_BYTE_LIMIT,
  hostPathEquals,
  measureTextWorkload,
  type HostPath,
} from '../../shared'
import type {
  ReviewCheckpointHostRequest,
  ReviewCheckpointHostResult,
  ReviewCheckpointInspection,
  ReviewCheckpointObject,
} from '../../shared/review-checkpoint'
import type { ExecOptions, ProjectHost } from '../project-host'
import { readCheckpointFile, type CheckpointFile } from './review-checkpoint-file'
import {
  assertCheckpointRelativePath,
  CHECKPOINT_MAX_ENTRIES,
  CHECKPOINT_MAX_TREE_BYTES,
  encodeCheckpointTree,
  isCheckpointObjectId,
  parseCheckpointTree,
} from './review-checkpoint-model'
import {
  ReviewCheckpointOperations,
  type CheckpointOperationGrant,
  type CheckpointOperationKind,
  type CheckpointOperationLease,
  type CheckpointOperationScope,
} from './review-checkpoint-operations'

export interface CheckpointHostAuthority extends CheckpointOperationScope {
  readonly host: ProjectHost
}

interface HostOperation {
  readonly authority: CheckpointHostAuthority
  readonly canonicalRoot?: HostPath
  readonly inspection?: ReviewCheckpointInspection
  readonly paths: ReadonlySet<string>
  readonly blobs: ReadonlySet<string>
  readonly trees: ReadonlySet<string>
  readonly baselineBlobs: ReadonlySet<string>
}

const CHECKPOINT_ENV_UNSET = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_COMMON_DIR',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_NAMESPACE',
  'GIT_CONFIG_COUNT',
  'GIT_CONFIG_PARAMETERS',
] as const

export class ReviewCheckpointHost {
  private readonly operations = new ReviewCheckpointOperations()
  private readonly hosts = new Map<string, HostOperation>()

  begin(
    authority: CheckpointHostAuthority,
    kind: CheckpointOperationKind,
  ): CheckpointOperationGrant {
    const grant = this.operations.begin(authority, kind)
    this.hosts.set(grant.id, {
      authority,
      paths: new Set(),
      blobs: new Set(),
      trees: new Set(),
      baselineBlobs: new Set(),
    })
    grant.signal.addEventListener('abort', () => this.hosts.delete(grant.id), {
      once: true,
    })
    return grant
  }

  async dispatch(
    id: string,
    authority: CheckpointHostAuthority,
    request: ReviewCheckpointHostRequest,
  ): Promise<ReviewCheckpointHostResult> {
    return this.operations.run(id, authority, async (lease) => {
      const operation = this.hosts.get(id)
      if (
        !operation ||
        operation.authority.host !== authority.host ||
        authority.host.connectionState !== 'connected'
      )
        throw new Error('Checkpoint host authority changed')
      const canonicalRoot = await authority.host.realpath(authority.root)
      lease.assertActive()
      if (
        canonicalRoot.hostId !== authority.root.hostId ||
        (operation.canonicalRoot &&
          !hostPathEquals(operation.canonicalRoot, canonicalRoot))
      )
        throw new Error('Checkpoint workspace root changed')
      const current = { ...operation, canonicalRoot }
      this.hosts.set(id, current)
      return this.perform(id, current, lease, request)
    })
  }

  dispose(): void {
    this.operations.dispose()
    this.hosts.clear()
  }

  private async perform(
    id: string,
    operation: HostOperation,
    lease: CheckpointOperationLease,
    request: ReviewCheckpointHostRequest,
  ): Promise<ReviewCheckpointHostResult> {
    switch (request.action) {
      case 'inspect':
        return this.inspect(id, operation, lease)
      case 'files':
        return this.files(id, operation, lease)
      case 'tracked':
        return this.command(operation, lease, [
          'ls-files',
          '--stage',
          '-v',
          '-z',
          '--',
          '.',
        ])
      case 'hash': {
        if (request.write) lease.assertCapture()
        this.assertListed(operation, request.relativePath)
        const file = await readCheckpointFile(
          operation.authority.host,
          operation.authority.root,
          request.relativePath,
          lease.signal,
        )
        const object = await this.hash(operation, lease, file, request.write)
        if (object && request.write)
          this.hosts.set(id, {
            ...operation,
            blobs: new Set([...operation.blobs, object.oid]),
          })
        return object
      }
      case 'tree': {
        if (request.oid !== operation.inspection?.oid)
          throw new Error('Checkpoint baseline changed')
        const output = await this.command(operation, lease, [
          'ls-tree',
          '-rz',
          '--full-tree',
          request.oid,
        ])
        const entries = parseCheckpointTree(output)
        this.hosts.set(id, {
          ...operation,
          baselineBlobs: new Set(entries.map((entry) => entry.oid)),
        })
        return output
      }
      case 'write-tree':
        return this.writeTree(id, operation, lease, request.entries)
      case 'update-ref': {
        lease.assertCapture()
        if (
          !operation.trees.has(request.oid) ||
          operation.inspection?.oid !== request.previous
        )
          throw new Error('Checkpoint ref target was not produced by this capture')
        lease.finishRef()
        return this.command(operation, lease, [
          'update-ref',
          '--no-deref',
          checkpointRef(operation),
          request.oid,
          request.previous ?? '0'.repeat(request.oid.length),
        ])
      }
      case 'clear-ref': {
        if (
          lease.kind !== 'clear' ||
          !isCheckpointObjectId(request.previous) ||
          operation.inspection?.oid !== request.previous
        )
          throw new Error('Checkpoint clear authority does not match the saved baseline')
        lease.finishRef()
        return this.command(operation, lease, [
          'update-ref',
          '--no-deref',
          '-d',
          checkpointRef(operation),
          request.previous,
        ])
      }
      case 'blob':
        return this.blob(operation, lease, request.oid)
      case 'read-live': {
        assertCheckpointRelativePath(request.relativePath)
        const file = await readCheckpointFile(
          operation.authority.host,
          operation.authority.root,
          request.relativePath,
          lease.signal,
        )
        const object = await this.hash(operation, lease, file, false)
        if (
          object?.oid !== request.expected?.oid ||
          object?.mode !== request.expected?.mode
        )
          throw new Error('File changed since comparison; refresh changes since review')
        return file
          ? checkpointText(
              file.bytes.toString('utf8'),
              file.bytes.byteLength <= DIFF_INPUT_BYTE_LIMIT,
            )
          : measureTextWorkload('')
      }
      default:
        throw new Error('Unsupported review checkpoint host action')
    }
  }

  private async inspect(
    id: string,
    operation: HostOperation,
    lease: CheckpointOperationLease,
  ): Promise<ReviewCheckpointInspection> {
    const sparse = await this.exec(operation, lease, [
      'config',
      '--bool',
      '--get',
      'core.sparseCheckout',
    ])
    if (sparse.code !== 0 && sparse.code !== 1)
      throw new Error('Cannot inspect sparse checkout configuration')
    if (sparse.stdout.trim() === 'true')
      throw new Error('Sparse checkouts are not supported by review checkpoints')
    const objectFormat = (
      await this.command(operation, lease, ['rev-parse', '--show-object-format'])
    ).trim()
    if (objectFormat !== 'sha1' && objectFormat !== 'sha256')
      throw new Error('Unsupported Git object format')
    const saved = await this.exec(operation, lease, [
      'rev-parse',
      '--verify',
      '--quiet',
      checkpointRef(operation),
    ])
    if (saved.code !== 0 && saved.code !== 1)
      throw new Error('Cannot read review checkpoint ref')
    const oid = saved.code === 1 ? null : objectId(saved.stdout)
    if (
      oid &&
      (await this.command(operation, lease, ['cat-file', '-t', oid])).trim() !== 'tree'
    )
      throw new Error('Review checkpoint ref does not identify a tree')
    const inspection: ReviewCheckpointInspection = {
      root: operation.canonicalRoot!,
      oid,
      objectFormat,
    }
    this.hosts.set(id, { ...operation, inspection })
    return inspection
  }

  private async files(
    id: string,
    operation: HostOperation,
    lease: CheckpointOperationLease,
  ): Promise<string> {
    if (!operation.inspection)
      throw new Error('Inspect the checkpoint before listing files')
    const output = await this.command(operation, lease, [
      'ls-files',
      '--cached',
      '--others',
      '--exclude-standard',
      '-z',
      '--',
      '.',
    ])
    if (output && !output.endsWith('\0'))
      throw new Error('Truncated checkpoint file list')
    const paths = output ? output.slice(0, -1).split('\0') : []
    if (paths.length > CHECKPOINT_MAX_ENTRIES)
      throw new Error('Checkpoint file count limit exceeded')
    for (const path of paths) assertCheckpointRelativePath(path)
    if (new Set(paths).size !== paths.length)
      throw new Error('Unmerged checkpoint paths are unsupported')
    this.hosts.set(id, { ...operation, paths: new Set(paths) })
    return output
  }

  private async hash(
    operation: HostOperation,
    lease: CheckpointOperationLease,
    file: CheckpointFile | null,
    write: boolean,
  ): Promise<ReviewCheckpointObject | null> {
    lease.charge({ files: 1, bytes: file?.bytes.byteLength ?? 0 })
    if (!file) return null
    lease.assertActive()
    const oid = objectId(
      await this.command(
        operation,
        lease,
        ['hash-object', '--no-filters', ...(write ? ['-w'] : []), '--stdin'],
        { input: file.bytes, maxBuffer: 1024 },
      ),
    )
    return { mode: file.mode, oid }
  }

  private async writeTree(
    id: string,
    operation: HostOperation,
    lease: CheckpointOperationLease,
    entries: Extract<ReviewCheckpointHostRequest, { action: 'write-tree' }>['entries'],
  ): Promise<string> {
    lease.assertCapture()
    const input = encodeCheckpointTree(entries)
    for (const entry of entries) {
      if (!(entry.mode === '040000' ? operation.trees : operation.blobs).has(entry.oid))
        throw new Error('Tree object was not produced by this capture')
    }
    lease.charge({ trees: 1, bytes: Buffer.byteLength(input) })
    const oid = objectId(
      await this.command(operation, lease, ['mktree', '-z'], { input, maxBuffer: 1024 }),
    )
    this.hosts.set(id, { ...operation, trees: new Set([...operation.trees, oid]) })
    return oid
  }

  private async blob(
    operation: HostOperation,
    lease: CheckpointOperationLease,
    oid: string,
  ) {
    if (!operation.baselineBlobs.has(oid))
      throw new Error('Blob is not part of the saved review checkpoint')
    const result = await this.exec(operation, lease, ['cat-file', 'blob', oid], {
      maxBuffer: DIFF_INPUT_BYTE_LIMIT + 1,
      allowTruncatedOutput: true,
    })
    if (result.code !== 0 && !result.outputTruncated)
      throw new Error('Cannot read checkpoint blob')
    return checkpointText(result.stdout, !result.outputTruncated)
  }

  private assertListed(operation: HostOperation, path: string): void {
    assertCheckpointRelativePath(path)
    if (!operation.paths.has(path))
      throw new Error('Path is not in this checkpoint file listing')
  }

  private async command(
    operation: HostOperation,
    lease: CheckpointOperationLease,
    args: readonly string[],
    options?: ExecOptions,
  ): Promise<string> {
    const result = await this.exec(operation, lease, args, options)
    if (result.code !== 0 || result.outputTruncated)
      throw new Error(`Checkpoint Git ${args[0]} failed; the baseline was not advanced`)
    return result.stdout
  }

  private async exec(
    operation: HostOperation,
    lease: CheckpointOperationLease,
    args: readonly string[],
    options: ExecOptions = {},
  ) {
    lease.assertActive()
    const { host, root } = operation.authority
    const result = await host.exec(
      'git',
      [
        '--no-replace-objects',
        '-c',
        'core.fsmonitor=false',
        '-c',
        'core.hooksPath=/dev/null',
        '-C',
        root.path,
        ...args,
      ],
      {
        ...options,
        cwd: root,
        env: { GIT_OPTIONAL_LOCKS: '0' },
        unsetEnv: CHECKPOINT_ENV_UNSET,
        signal: lease.signal,
        timeout: 30_000,
        maxBuffer: options.maxBuffer ?? CHECKPOINT_MAX_TREE_BYTES,
      },
    )
    lease.assertActive()
    return result
  }
}

function checkpointRef(operation: HostOperation): string {
  if (!operation.canonicalRoot)
    throw new Error('Checkpoint root has not been canonicalized')
  const digest = createHash('sha256')
    .update(JSON.stringify(operation.canonicalRoot))
    .digest('hex')
  return `refs/worktree/hvir-review/${digest}`
}

function objectId(output: string): string {
  const oid = output.trim()
  if (!isCheckpointObjectId(oid)) throw new Error('Invalid checkpoint object identity')
  return oid
}

function checkpointText(text: string, complete: boolean) {
  if (text.includes('\0') || text.includes('\uFFFD'))
    throw new Error(
      'Binary or non-UTF-8 checkpoint content cannot be shown as a text diff',
    )
  return boundTextWorkload(text, DIFF_INPUT_BYTE_LIMIT, complete)
}
