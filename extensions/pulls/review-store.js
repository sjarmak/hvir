/* global window, module */
;(() => {
  const CONNECTOR = 'store'
  const NAME = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/
  const MAX_VALUE_BYTES = 12 * 1024
  const SCRIPT = [
    'd="$HOME/.hvir/pulls"',
    'case "$1" in',
    'list) [ -d "$d" ] || exit 0; for f in "$d/$2"*.json; do [ -f "$f" ] || continue; n=${f##*/}; printf "%s\\t" "${n%.json}"; cat "$f"; printf "\\n"; done ;;',
    'write) mkdir -p "$d" && printf "%s" "$3" > "$d/.$2.tmp" && mv -f "$d/.$2.tmp" "$d/$2.json" ;;',
    'remove) rm -f "$d/$2.json" ;;',
    '*) echo "unknown store command" >&2; exit 2 ;;',
    'esac',
  ].join('\n')

  function slug(repo) {
    const [owner, name] = repo.toLowerCase().split('/')
    return `${owner}__${name}`
  }

  const repoPrefix = (repo) => `${slug(repo)}+`
  const pullPrefix = (repo, number) => `${slug(repo)}+${number}+`
  const reviewName = (repo, number) => `${pullPrefix(repo, number)}review`
  const draftName = (repo, number, id) => `${pullPrefix(repo, number)}draft-${id}`
  const asideName = (repo) => `${repoPrefix(repo)}aside`

  function checkName(name) {
    if (!NAME.test(name)) throw new Error(`Invalid review store name: ${name}`)
    return name
  }

  const listArgs = (prefix) => ['-c', SCRIPT, 'sh', 'list', checkName(prefix)]
  const removeArgs = (name) => ['-c', SCRIPT, 'sh', 'remove', checkName(name)]

  function writeArgs(name, value) {
    const json = JSON.stringify(value)
    const bytes = new TextEncoder().encode(JSON.stringify(json)).length
    if (bytes > MAX_VALUE_BYTES)
      throw new Error(
        `Too large to save (${Math.ceil(bytes / 1024)} KiB, limit ${MAX_VALUE_BYTES / 1024} KiB)`,
      )
    return ['-c', SCRIPT, 'sh', 'write', checkName(name), json]
  }

  function parseListing(stdout) {
    const entries = new Map()
    for (const line of stdout.split('\n')) {
      const tab = line.indexOf('\t')
      if (tab < 1) continue
      try {
        entries.set(line.slice(0, tab), JSON.parse(line.slice(tab + 1)))
      } catch {
        entries.set(line.slice(0, tab), undefined)
      }
    }
    return entries
  }

  function client(run, workspace) {
    return Object.freeze({
      list: async (prefix) =>
        parseListing(await run(CONNECTOR, workspace, listArgs(prefix), { text: true })),
      write: (name, value) =>
        run(CONNECTOR, workspace, writeArgs(name, value), { text: true }),
      remove: (name) => run(CONNECTOR, workspace, removeArgs(name), { text: true }),
    })
  }

  const api = Object.freeze({
    CONNECTOR,
    MAX_VALUE_BYTES,
    repoPrefix,
    pullPrefix,
    reviewName,
    draftName,
    asideName,
    listArgs,
    writeArgs,
    removeArgs,
    parseListing,
    client,
  })
  if (typeof module === 'object') module.exports = api
  else window.reviewStore = api
})()
