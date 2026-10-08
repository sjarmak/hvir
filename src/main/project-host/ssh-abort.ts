import type { SFTPWrapper } from 'ssh2'
import { retainSftpErrorHandler } from './ssh-sftp-errors'

export function writeSftpFile(
  session: SFTPWrapper,
  path: string,
  data: Buffer,
  mode: number | undefined,
  signal: AbortSignal | undefined,
  done: (reason: Error | null | undefined, value: void) => void,
): void {
  const abortReason = (): Error =>
    signal?.reason instanceof Error ? signal.reason : abortError()
  if (signal?.aborted) {
    done(abortReason(), undefined)
    return
  }
  const stream = session.createWriteStream(path, mode === undefined ? {} : { mode })
  const state = stream as typeof stream & {
    readonly bytesWritten?: number
    readonly _writableState?: { readonly errored?: Error | null }
  }
  let settled = false
  const abort = () => {
    finish(abortReason())
    stream.destroy()
  }
  const finish = (reason?: Error): void => {
    if (settled) return
    settled = true
    signal?.removeEventListener('abort', abort)
    stream.removeListener('close', onClose)
    session.removeListener('error', onSessionError)
    session.removeListener('close', onSessionClose)
    releaseErrors()
    done(reason, undefined)
  }
  const onError = (reason: Error) => finish(reason)
  const onClose = () =>
    queueMicrotask(() => {
      const reason = state.errored ?? state._writableState?.errored
      if (reason) finish(reason)
      else if (state.bytesWritten !== undefined && state.bytesWritten !== data.length)
        finish(interruptedWrite())
      else finish()
    })
  const onSessionError = (reason: Error) => finish(reason)
  const onSessionClose = () => finish(interruptedWrite())
  const releaseErrors = retainSftpErrorHandler(stream, onError)
  stream.once('close', onClose)
  session.once('error', onSessionError)
  session.once('close', onSessionClose)
  signal?.addEventListener('abort', abort, { once: true })
  stream.end(data)
}

function interruptedWrite(): Error {
  return new Error('SSH file write interrupted before completion')
}

export function withAbort<T>(task: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return task
  if (signal.aborted) return Promise.reject(abortError())
  return new Promise<T>((resolve, reject) => {
    let settled = false
    const abort = () => finish(abortError())
    const finish = (reason?: unknown, value?: T): void => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', abort)
      if (reason !== undefined) {
        reject(reason instanceof Error ? reason : new Error('SSH file operation failed'))
      } else resolve(value as T)
    }
    signal.addEventListener('abort', abort, { once: true })
    void task.then(
      (value) => finish(undefined, value),
      (reason: unknown) => finish(reason),
    )
  })
}

export function abortError(): Error {
  const error = new Error('The operation was aborted')
  error.name = 'AbortError'
  return error
}
