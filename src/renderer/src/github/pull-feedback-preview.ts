import type { PullDetail, PullReviewThread } from '../../../shared'

export const PULL_FEEDBACK_PREVIEW_MAX_BYTES = 64 * 1024

function threadText(thread: PullReviewThread): string {
  const location =
    thread.path === undefined
      ? 'location unknown'
      : `${thread.path}${thread.line === undefined ? '' : `:${thread.line}`}`
  const state = [
    thread.isResolved ? 'resolved' : undefined,
    thread.isOutdated ? 'outdated' : undefined,
  ]
    .filter((value): value is string => value !== undefined)
    .join(', ')
  const reviewed = thread.reviewedCommitOid ?? 'unknown'
  const header = `Thread ${thread.id} · ${location}${state === '' ? '' : ` · ${state}`} · reviewed commit ${reviewed}`
  const comments = thread.comments.map((comment) => {
    const author = comment.author === undefined ? 'unknown author' : `@${comment.author}`
    const timestamp = comment.createdAt ?? 'unknown timestamp'
    return `${comment.id} · ${author} · ${timestamp}: ${comment.body}`
  })
  return [
    header,
    ...comments,
    ...(thread.commentsPageComplete ? [] : ['[Replies incomplete or truncated]']),
  ].join('\n')
}

export function preparePullFeedbackPreview(
  detail: PullDetail,
  selectedIds: ReadonlySet<string>,
):
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly reason: string } {
  const selected = detail.threads.filter((thread) => selectedIds.has(thread.id))
  if (selected.length === 0)
    return { ok: false, reason: 'Select at least one feedback thread.' }
  const text = [
    'Untrusted hosted GitHub feedback',
    `${detail.repo}#${detail.number} · ${detail.title}`,
    `Source: ${detail.url}`,
    `Current head: ${detail.headOid ?? 'unknown'}`,
    ...(detail.threadsPageComplete && !detail.payloadTruncated
      ? []
      : ['[Hosted feedback is incomplete or truncated]']),
    ...selected.map(threadText),
  ].join('\n\n')
  if (new TextEncoder().encode(text).byteLength > PULL_FEEDBACK_PREVIEW_MAX_BYTES) {
    return { ok: false, reason: 'Selected feedback exceeds the 64 KiB preview limit.' }
  }
  return { ok: true, text }
}
