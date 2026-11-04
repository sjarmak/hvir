/* global window, module */
;(() => {
  function parentsOf(pulls, repo) {
    const heads = new Map(
      pulls
        .filter((pull) => pull.headRepo === repo.toLowerCase())
        .map((pull) => [pull.headRef, pull]),
    )
    return new Map(
      pulls.flatMap((pull) => {
        const parent = heads.get(pull.baseRef)
        return parent && parent.number !== pull.number ? [[pull.number, parent.number]] : []
      }),
    )
  }

  function walk(number, childrenOf, depth, seen) {
    if (seen.has(number)) return []
    seen.add(number)
    return [
      { number, depth },
      ...(childrenOf.get(number) ?? []).flatMap((child) => walk(child, childrenOf, depth + 1, seen)),
    ]
  }

  function pullStacks(pulls, repo) {
    const open = pulls.filter(
      (pull, index) => pull.state === 'open' && pulls.findIndex((other) => other.number === pull.number) === index,
    )
    const parents = parentsOf(open, repo)
    const childrenOf = new Map()
    for (const [child, parent] of [...parents].sort(([a], [b]) => a - b))
      childrenOf.set(parent, [...(childrenOf.get(parent) ?? []), child])
    const roots = [...childrenOf.keys()].filter((number) => !parents.has(number)).sort((a, b) => a - b)
    const seen = new Set()
    const stacks = roots.map((root, index) => ({ id: index, members: walk(root, childrenOf, 0, seen) }))
    return new Map(
      stacks.flatMap((stack) =>
        stack.members.map((member, position) => [
          member.number,
          {
            id: stack.id,
            position,
            depth: member.depth,
            parent: parents.get(member.number),
            order: stack.members.map((entry) => entry.number),
          },
        ]),
      ),
    )
  }

  const api = Object.freeze({ pullStacks })
  if (typeof module === 'object') module.exports = api
  else window.pullStacks = api
})()
