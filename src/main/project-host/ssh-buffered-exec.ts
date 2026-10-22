import { randomUUID } from 'node:crypto'
import { StringDecoder } from 'node:string_decoder'
import type { Client, ClientChannel } from 'ssh2'
import type { ExecResult } from '../../shared/fs-types'
import type { ExecOptions } from './project-host'
import type { SshTransportPool } from './ssh-transport-pool'
import { recoverBufferedExecStatus, remoteBufferedCommand } from './ssh-remote-command'

export function startBufferedSshExec(
  pool: SshTransportPool,
  command: string,
  args: readonly string[],
  opts: ExecOptions,
): Promise<ExecResult> | undefined {
  const statusMarker = `__hvir_exec_status_${randomUUID()}__`
  const open = (client: Client) =>
    new Promise<ClientChannel>((resolve, reject) => {
      try {
        client.exec(
          remoteBufferedCommand(command, args, opts, statusMarker),
          (error, value) => (error ? reject(error) : resolve(value)),
        )
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  const channel = pool.tryOpenFiniteChannel(open, opts.signal)
  return channel?.then((stream) => collectBufferedSshExec(stream, opts, statusMarker))
}

function collectBufferedSshExec(
  stream: ClientChannel,
  opts: ExecOptions,
  statusMarker: string,
): Promise<ExecResult> {
  return new Promise<ExecResult>((resolve, reject) => {
    const maximum =
      (opts.maxBuffer ?? 10 * 1024 * 1024) + Buffer.byteLength(statusMarker) + 3
    let stdout = '',
      stderr = '',
      bytes = 0,
      stdoutNulRecords = 0,
      code: number | null = null,
      signal: string | null = null
    let settled = false
    let terminalError: Error | undefined
    let truncated = false
    const stdoutDecoder = new StringDecoder('utf8')
    const stderrDecoder = new StringDecoder('utf8')
    const append = (kind: 'out' | 'err', chunk: Buffer): void => {
      if (truncated) return
      bytes += chunk.length
      if (kind === 'out' && opts.maxStdoutNulRecords !== undefined) {
        for (const byte of chunk) if (byte === 0) stdoutNulRecords++
      }
      if (kind === 'out') stdout += stdoutDecoder.write(chunk)
      else stderr += stderrDecoder.write(chunk)
      if (
        bytes > maximum ||
        (opts.maxStdoutNulRecords !== undefined &&
          stdoutNulRecords >= opts.maxStdoutNulRecords)
      ) {
        if (opts.allowTruncatedOutput) {
          truncated = true
          return stream.close()
        }
        terminalError = new Error('SSH exec output exceeded maxBuffer')
        return stream.close()
      }
    }
    stream.on('data', (chunk: Buffer) => append('out', chunk))
    stream.stderr.on('data', (chunk: Buffer) => append('err', chunk))
    stream.on('exit', (exitCode: number | null, exitSignal?: string) => {
      code = exitCode
      signal = exitSignal ?? null
    })
    stream.on('error', (reason: Error) => {
      terminalError = reason
      stream.close()
    })
    stream.on('close', () => {
      if (!settled && terminalError) reject(terminalError)
      else if (!settled) {
        stdout += stdoutDecoder.end()
        stderr += stderrDecoder.end()
        const recovered = recoverBufferedExecStatus(stderr, statusMarker)
        resolve({
          code: recovered.code ?? code,
          signal,
          stdout,
          stderr: recovered.stderr,
          ...(truncated ? { outputTruncated: true } : {}),
        })
      }
      settled = true
    })
    if (opts.signal) {
      const abort = (): void => {
        terminalError = new DOMException('The operation was aborted', 'AbortError')
        stream.close()
      }
      stream.once('close', () => opts.signal?.removeEventListener('abort', abort))
      opts.signal.addEventListener('abort', abort, { once: true })
      if (opts.signal.aborted) {
        abort()
        return
      }
    }
    stream.end(opts.input)
  })
}
