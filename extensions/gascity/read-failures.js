;(() => {
  const MAX_ENTRIES = 50
  const STDERR_TAIL_CHARS = 2048

  const tail = (text) => (typeof text === 'string' ? text.slice(-STDERR_TAIL_CHARS) : '')

  const NOT_FROM_STDERR = 'error message not from stderr (not recorded)'

  const stderrLines = (stderr) =>
    typeof stderr === 'string'
      ? stderr
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean)
      : []

  const safeMessage = (error) => {
    const message = typeof error.message === 'string' ? error.message.trim() : ''
    if (typeof error.reason === 'string') return error.message
    return message && stderrLines(error.stderr).includes(message)
      ? message
      : NOT_FROM_STDERR
  }

  const entry = ({ at, field, connector, args, error }) =>
    Object.freeze({
      time: new Date(at).toISOString(),
      field,
      command: [connector, ...args].join(' '),
      exitCode: Number.isInteger(error.exitCode) ? error.exitCode : null,
      stderr: tail(error.stderr),
      message: tail(safeMessage(error)),
    })

  const record = (log, entries) => Object.freeze([...log, ...entries].slice(-MAX_ENTRIES))

  const firstLine = (text) => (text ?? '').split('\n').find((line) => line.trim()) ?? ''

  const text = (failed) =>
    `Last failed read ${failed.time.slice(11, 19)} UTC, ${failed.field}: ${firstLine(failed.stderr) || firstLine(failed.message)}`

  const api = Object.freeze({
    MAX_ENTRIES,
    STDERR_TAIL_CHARS,
    NOT_FROM_STDERR,
    entry,
    record,
    text,
  })
  if (typeof module === 'object') module.exports = api
  else window.readFailures = api
})()
