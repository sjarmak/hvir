import type { ReactElement } from 'react'

import {
  historyRangeEnds,
  type HistoryCommitRange,
} from '../architecture-review/architecture-ends-model'

interface GitHistoryRangeBarProps {
  readonly range: HistoryCommitRange
  readonly onShowRangeInArchitecture: (range: HistoryCommitRange) => void
  readonly onClear: () => void
}

export function GitHistoryRangeBar({
  range,
  onShowRangeInArchitecture,
  onClear,
}: GitHistoryRangeBarProps): ReactElement {
  const ends = historyRangeEnds(range)
  const count = range.hashes.length
  return (
    <div className="git-history-range" role="status">
      <span>
        {count} {count === 1 ? 'commit' : 'commits'} selected
        {ends === undefined
          ? `, but ${range.olderCommit.shortHash} has no parent to compare from`
          : ''}
      </span>
      <button
        type="button"
        className="git-history-range-show"
        disabled={ends === undefined}
        title="Open the Architecture tab locked to the state before the oldest selected commit"
        onClick={() => onShowRangeInArchitecture(range)}
      >
        Show range in architecture
      </button>
      <button type="button" className="git-history-range-clear" onClick={onClear}>
        Clear
      </button>
    </div>
  )
}
