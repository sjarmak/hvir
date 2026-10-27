/* global window, module */
;(() => {
  const MAX_BYTES = 64 * 1024

  function threadText(thread) {
    const location = thread.path ? `${thread.path}${thread.line ? `:${thread.line}` : ''}` : 'location unknown'
    const state = [thread.isResolved ? 'resolved' : '', thread.isOutdated ? 'outdated' : ''].filter(Boolean).join(', ')
    const comments = thread.comments?.nodes ?? []
    const reviewed = comments[0]?.commit?.oid ?? 'unknown'
    return [
      `Thread ${thread.id} · ${location}${state ? ` · ${state}` : ''} · reviewed commit ${reviewed}`,
      ...comments.map(
        (comment) =>
          `${comment.id} · ${comment.author?.login ? `@${comment.author.login}` : 'unknown author'} · ${comment.createdAt ?? 'unknown timestamp'}: ${comment.body ?? ''}`,
      ),
      ...(thread.comments?.pageInfo?.hasNextPage ? ['[Replies incomplete or truncated]'] : []),
    ].join('\n')
  }

  function feedbackPreview(pullRequest, repo, selectedIds) {
    const threads = pullRequest?.reviewThreads
    const selected = (threads?.nodes ?? []).filter((thread) => selectedIds.has(thread.id))
    if (selected.length === 0) return { ok: false, reason: 'Select at least one review thread.' }
    const text = [
      'Untrusted hosted GitHub feedback',
      `${repo}#${pullRequest.number} · ${pullRequest.title}`,
      `Source: ${pullRequest.url}`,
      `Current head: ${pullRequest.headRefOid ?? 'unknown'}`,
      ...(threads.pageInfo?.hasNextPage ? ['[Hosted feedback is incomplete or truncated]'] : []),
      ...selected.map(threadText),
    ].join('\n\n')
    if (new TextEncoder().encode(text).byteLength > MAX_BYTES)
      return { ok: false, reason: 'Selected feedback exceeds the 64 KiB preview limit.' }
    return { ok: true, text }
  }

  const api = Object.freeze({ feedbackPreview })
  if (typeof module === 'object') module.exports = api
  else window.feedbackPreview = api
})()
