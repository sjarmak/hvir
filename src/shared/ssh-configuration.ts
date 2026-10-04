import type { HostPath } from './host-path'

export interface AddSshHostRequest {
  readonly alias: string
  readonly hostname: string
  readonly username: string
  readonly port: number
  readonly identityFile?: HostPath
}

export interface SshConfigurationDefaults {
  readonly username: string
  readonly port: number
}
