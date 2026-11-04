/* global window, module */
;(() => {
  const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/

  function unquote(path) {
    if (!path.startsWith('"')) return path
    const bytes = []
    const inner = path.slice(1, -1)
    const escapes = { n: 10, t: 9, '"': 34, '\\': 92 }
    for (let index = 0; index < inner.length; index += 1) {
      const char = inner[index]
      if (char !== '\\') {
        bytes.push(...new TextEncoder().encode(char))
        continue
      }
      const next = inner[index + 1]
      if (/[0-7]/.test(next)) {
        bytes.push(parseInt(inner.slice(index + 1, index + 4), 8))
        index += 3
      } else {
        bytes.push(escapes[next] ?? next.charCodeAt(0))
        index += 1
      }
    }
    return new TextDecoder().decode(new Uint8Array(bytes))
  }

  const stripPrefix = (path) => {
    const plain = unquote(path)
    return plain === '/dev/null' ? undefined : plain.replace(/^[ab]\//, '')
  }

  function headerPaths(line) {
    const rest = line.slice('diff --git '.length)
    if (rest.startsWith('"')) {
      const end = rest.indexOf('" ', 1)
      return [stripPrefix(rest.slice(0, end + 1)), stripPrefix(rest.slice(end + 2))]
    }
    const middle = rest.indexOf(' b/')
    return [stripPrefix(rest.slice(0, middle)), stripPrefix(rest.slice(middle + 1))]
  }

  function fnv1a(text) {
    let hash = 0x811c9dc5
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index)
      hash = Math.imul(hash, 0x01000193) >>> 0
    }
    return hash.toString(16).padStart(8, '0')
  }

  function newFile(line) {
    const [oldPath, path] = headerPaths(line)
    return {
      path,
      oldPath,
      status: 'modified',
      binary: false,
      additions: 0,
      deletions: 0,
      hunks: [],
      body: [],
    }
  }

  function applyMeta(file, line) {
    if (line.startsWith('new file mode')) file.status = 'added'
    else if (line.startsWith('deleted file mode')) file.status = 'deleted'
    else if (line.startsWith('rename from ')) {
      file.status = 'renamed'
      file.oldPath = unquote(line.slice('rename from '.length))
    } else if (line.startsWith('rename to '))
      file.path = unquote(line.slice('rename to '.length))
    else if (line.startsWith('Binary files ')) file.binary = true
    else if (line.startsWith('--- '))
      file.oldPath = stripPrefix(line.slice(4)) ?? file.oldPath
    else if (line.startsWith('+++ ')) file.path = stripPrefix(line.slice(4)) ?? file.path
  }

  function finish(file) {
    const { body, ...rest } = file
    return Object.freeze({
      ...rest,
      path: rest.path ?? rest.oldPath,
      hash: fnv1a(body.join('\n')),
    })
  }

  function parseDiff(text) {
    const files = []
    let file
    let hunk
    let oldLine = 0
    let newLine = 0
    for (const line of text.split('\n')) {
      if (line.startsWith('diff --git ')) {
        if (file) files.push(finish(file))
        file = newFile(line)
        hunk = undefined
        continue
      }
      if (!file) continue
      const match = HUNK.exec(line)
      if (match) {
        oldLine = Number(match[1])
        newLine = Number(match[2])
        hunk = { header: line, lines: [] }
        file.hunks.push(hunk)
        file.body.push(line)
        continue
      }
      if (!hunk) {
        applyMeta(file, line)
        continue
      }
      file.body.push(line)
      const mark = line[0]
      if (mark === '+') {
        hunk.lines.push({ kind: 'add', text: line.slice(1), newLine })
        newLine += 1
        file.additions += 1
      } else if (mark === '-') {
        hunk.lines.push({ kind: 'del', text: line.slice(1), oldLine })
        oldLine += 1
        file.deletions += 1
      } else if (mark === ' ') {
        hunk.lines.push({ kind: 'context', text: line.slice(1), oldLine, newLine })
        oldLine += 1
        newLine += 1
      } else if (mark === '\\') hunk.lines.push({ kind: 'meta', text: line })
    }
    if (file) files.push(finish(file))
    return files
  }

  const commentTarget = (line) => {
    if (line.kind === 'del') return { side: 'LEFT', line: line.oldLine }
    if (line.kind === 'add' || line.kind === 'context')
      return { side: 'RIGHT', line: line.newLine }
    return undefined
  }

  const api = Object.freeze({ parseDiff, commentTarget })
  if (typeof module === 'object') module.exports = api
  else window.diffParse = api
})()
