import { getSystemErrorName } from 'node:util'

import { ProjectPathExistsError } from './project-host'

export function atomicRenameError(errno: number): Error {
  let code = 'UNKNOWN'
  try {
    code = getSystemErrorName(-errno)
  } catch {
    // Preserve a closed error when the platform reports an unknown errno.
  }
  if (code === 'EEXIST' || code === 'ENOTEMPTY') return new ProjectPathExistsError()
  return Object.assign(new Error(`Atomic no-replace publication failed with ${code}`), {
    code,
  })
}

export function watchCapacityError(error: Error): boolean {
  const code = (error as NodeJS.ErrnoException).code
  return code === 'EMFILE' || code === 'ENOSPC'
}
