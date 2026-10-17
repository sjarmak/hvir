import type { ReactElement } from 'react'

import { pullHandle, type HostPath, type PullSummary } from '../../../shared'
import type { PullCheckoutsResponse } from '../../../shared/github'
import { PullWorkspaceAction } from './PullWorkspaceAction'
import type { PullWorkspaceNavigation } from './pull-workspaces'
import {
  ageLabel,
  ageTone,
  checksLabel,
  reviewLabel,
  type PullSectionRow,
} from './pulls-model'

export interface PullRowProps {
  readonly row: PullSectionRow
  readonly now: number
  readonly showAuthor: boolean
  readonly root: HostPath
  readonly repo: string | undefined
  readonly checkouts: PullCheckoutsResponse | undefined
  readonly navigation: PullWorkspaceNavigation | undefined
  readonly disabled: boolean
  readonly detailLoading: boolean
  readonly onCheckouts: (response: PullCheckoutsResponse) => void
  readonly onDetail: (pull: PullSummary) => void
}

function AgeChip({ since, now }: { since: number; now: number }): ReactElement {
  return (
    <span
      className={`pulls-badge pulls-age pulls-age-${ageTone(since, now)}`}
      title={new Date(since).toLocaleString()}
    >
      {ageLabel(since, now)}
    </span>
  )
}

function Badges({
  row,
  now,
  showAuthor,
}: Pick<PullRowProps, 'row' | 'now' | 'showAuthor'>): ReactElement {
  const { pull, reason, since, waitingOn } = row
  const checks = checksLabel(pull.checks)
  const review = reviewLabel(pull.review)
  return (
    <span className="pulls-badges">
      {reason !== '' ? <span className="pulls-badge pulls-reason">{reason}</span> : null}
      {since !== undefined ? <AgeChip since={since} now={now} /> : null}
      {pull.state !== 'open' ? (
        <span className={`pulls-badge pulls-state-${pull.state}`}>{pull.state}</span>
      ) : null}
      {pull.draft ? <span className="pulls-badge">draft</span> : null}
      {checks !== '' ? (
        <span className={`pulls-badge pulls-checks-${pull.checks}`}>{checks}</span>
      ) : null}
      {review !== '' ? (
        <span className={`pulls-badge pulls-review-${pull.review}`}>{review}</span>
      ) : null}
      {pull.openFeedback > 0 ? (
        <span className="pulls-badge pulls-feedback">
          {pull.openFeedback} open {pull.openFeedback === 1 ? 'comment' : 'comments'}
        </span>
      ) : null}
      {showAuthor && pull.author !== '' ? (
        <span className="pulls-author">@{pull.author}</span>
      ) : null}
      {waitingOn.length > 0 ? (
        <span className="pulls-waiting-on">
          waiting on {waitingOn.map(pullHandle).join(', ')}
        </span>
      ) : null}
    </span>
  )
}

export function PullRow(props: PullRowProps): ReactElement {
  const { row, now, showAuthor, disabled, detailLoading, onDetail } = props
  const { pull } = row
  return (
    <div className="pulls-row" data-pull-number={pull.number}>
      <a
        className="pulls-link"
        href={pull.url}
        target="_blank"
        rel="noopener noreferrer"
        title={`${pull.headRef} · open on GitHub`}
      >
        <span className="pulls-line">
          <span className="pulls-number">#{pull.number}</span>
          <span className="pulls-row-title">{pull.title}</span>
        </span>
        <Badges row={row} now={now} showAuthor={showAuthor} />
      </a>
      <PullWorkspaceAction
        root={props.root}
        pull={pull}
        checkouts={props.checkouts}
        repo={props.repo}
        navigation={props.navigation}
        disabled={disabled}
        onCheckouts={props.onCheckouts}
      />
      <button
        type="button"
        className="pulls-detail-button"
        disabled={disabled || pull.headOid === undefined || detailLoading}
        onClick={() => onDetail(pull)}
      >
        {detailLoading ? 'Loading…' : 'Details'}
      </button>
    </div>
  )
}
