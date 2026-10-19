/* global window, module */
/**
 * `gc session peek` captures an agent's terminal pane without attaching. gc treats `--lines` as a
 * hint (a 5-line request can return a full screen), so the view trims to the cap itself.
 * Loaded by session.js and node --test.
 */
;(() => {
  const PEEK_LINES = 60

  const peekArgs = (sessionId) => [
    'session',
    'peek',
    sessionId,
    '--lines',
    String(PEEK_LINES),
  ]

  /** The last `max` lines of a pane capture, without the blank rows below the prompt. */
  function peekTail(stdout, max = PEEK_LINES) {
    const lines = stdout.replace(/\r\n/g, '\n').split('\n')
    let end = lines.length
    while (end > 0 && lines[end - 1].trim() === '') end--
    const kept = lines.slice(Math.max(0, end - max), end)
    return { text: kept.join('\n'), shown: kept.length, total: end }
  }

  const api = Object.freeze({ PEEK_LINES, peekArgs, peekTail })
  if (typeof module === 'object') module.exports = api
  else window.peek = api
})()
