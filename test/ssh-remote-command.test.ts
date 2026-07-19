import { describe, expect, it } from 'vitest'

import { asHostId, hostPath } from '../src/shared'
import {
  recoverBufferedExecStatus,
  remoteBufferedCommand,
  remoteCommand,
} from '../src/main/project-host/ssh-remote-command'

const cwd = hostPath(asHostId('remote'), '/work')

describe('remoteCommand', () => {
  it('single-quotes the command and every argument', () => {
    expect(remoteCommand('bd', ['list', '--json'], {})).toBe("'bd' 'list' '--json'")
  })

  it('embeds an env prefix and cwd change', () => {
    const remote = remoteCommand('bd', ['list'], { cwd, env: { FOO: 'bar' } })
    expect(remote).toBe("cd -- '/work' && env FOO='bar' 'bd' 'list'")
  })

  it('unsets requested variables before running', () => {
    expect(remoteCommand('bd', [], { unsetEnv: ['NODE_OPTIONS'] })).toBe(
      "env -u 'NODE_OPTIONS' 'bd'",
    )
  })

  it('escapes embedded single quotes', () => {
    expect(remoteCommand('echo', ["it's"], {})).toBe(`'echo' 'it'"'"'s'`)
  })

  it('wraps the whole invocation in a login shell so a profile PATH resolves', () => {
    // cwd stays inside the login shell so it still takes effect, and the `-l -c`
    // flags stay separate for shells (fish) that reject the combined `-lc` form.
    const remote = remoteCommand('bd', ['list'], { cwd }, '/bin/zsh')
    expect(remote).toBe(
      `'/bin/zsh' -l -c 'cd -- '"'"'/work'"'"' && '"'"'bd'"'"' '"'"'list'"'"''`,
    )
  })
})

describe('remoteBufferedCommand', () => {
  it('appends a status marker the client can recover the exit code from', () => {
    const remote = remoteBufferedCommand('bd', ['list'], {}, '__mark__')
    expect(remote).toContain("( 'bd' 'list' )")
    expect(remote).toContain(`printf '%s%s' '__mark__' "$hvir_status" >&2`)
  })

  it('threads the login shell through to the inner invocation', () => {
    const remote = remoteBufferedCommand('bd', [], {}, '__mark__', '/bin/sh')
    expect(remote).toContain("'/bin/sh' -l -c")
  })
})

describe('recoverBufferedExecStatus', () => {
  it('splits the trailing marker+code off stderr', () => {
    expect(recoverBufferedExecStatus('boom\n__mark__7', '__mark__')).toEqual({
      code: 7,
      stderr: 'boom\n',
    })
  })

  it('leaves stderr untouched when the marker is absent', () => {
    expect(recoverBufferedExecStatus('boom', '__mark__')).toEqual({ stderr: 'boom' })
  })

  it('ignores a non-numeric or out-of-range trailer', () => {
    expect(recoverBufferedExecStatus('x__mark__999', '__mark__')).toEqual({
      stderr: 'x__mark__999',
    })
    expect(recoverBufferedExecStatus('x__mark__nope', '__mark__')).toEqual({
      stderr: 'x__mark__nope',
    })
  })
})
