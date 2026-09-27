import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import type { HostPath } from '../../../shared'
import {
  ARCHITECTURE_BRANCH_POINT,
  architectureRefProblem,
  type ArchitectureCommit,
  type ArchitectureCommitChange,
  type ArchitectureCommitRange,
} from '../../../shared/architecture-review'
import {
  commitShownUnderFilter,
  setArchitectureFilter,
  useArchitectureFilter,
} from './architecture-history-filter'
import { commitDate } from '../git/commit-date'
import {
  useCommitClassifications,
  type CommitClassificationState,
} from './use-commit-classifications'
import {
  describeCommits,
  lockedBaseline,
  stripEnds,
  stripPosition,
  stripStep,
  type ArchitectureCommitDescriptions,
  type ArchitectureEnds,
  type StripStepping,
} from './architecture-ends-model'

interface ArchitectureCommitStripProps {
  readonly root: HostPath
  /** The chosen ends; a lock holds their Baseline, or the strip base when none is chosen. */
  readonly ends: ArchitectureEnds
  /** The scanned Current commit, when the snapshot has one. */
  readonly current?: string
  readonly disabled: boolean
  readonly locked?: string
  readonly onLock: (baseline: string | undefined) => void
  readonly onChoose: (
    ends: ArchitectureEnds,
    described: ArchitectureCommitDescriptions,
  ) => void
}

export function ArchitectureCommitStrip(props: ArchitectureCommitStripProps) {
  const { root, ends, current, disabled, locked, onLock, onChoose } = props
  const strip = useCommitRange(root)
  const range = strip.range
  const stepping: StripStepping =
    locked === undefined ? { kind: 'pairwise' } : { kind: 'locked', baseline: locked }
  const position = range && current ? stripPosition(range, current) : -1
  const architectureOnly = useArchitectureFilter()
  const revisions = useMemo(
    () => (range ? range.commits.map((commit) => commit.revision) : []),
    [range],
  )
  const classifications = useCommitClassifications(root, revisions)
  const shown = (index: number) => {
    const commit = range?.commits[index]
    return (
      commit !== undefined &&
      commitShownUnderFilter(
        architectureOnly,
        commit.merge,
        classifications.known.get(commit.revision),
      )
    )
  }
  const choose = (index: number | undefined) => {
    const chosen =
      range && index !== undefined ? stripEnds(range, index, stepping) : undefined
    if (chosen && range) onChoose(chosen, describeCommits(range, chosen))
  }
  const step = (direction: 1 | -1) =>
    range ? stripStep(range, position, direction, shown) : undefined
  return (
    <section className="architecture-strip" aria-label="Commit strip">
      <div className="architecture-strip-controls">
        <StripFrom loading={strip.loading} onLoad={strip.load} />
        <label>
          <input
            type="checkbox"
            checked={architectureOnly}
            onChange={(event) => setArchitectureFilter(event.target.checked)}
          />
          Architecture changes only
        </label>
        <label>
          <input
            type="checkbox"
            checked={locked !== undefined}
            disabled={!range}
            onChange={(event) =>
              onLock(
                event.target.checked && range ? lockedBaseline(ends, range) : undefined,
              )
            }
          />
          Lock baseline
        </label>
        {locked !== undefined && <span>Baseline held at {shortRef(locked)}</span>}
        <button
          type="button"
          disabled={disabled || step(-1) === undefined}
          onClick={() => choose(step(-1))}
        >
          Older commit
        </button>
        <button
          type="button"
          disabled={disabled || step(1) === undefined}
          onClick={() => choose(step(1))}
        >
          Newer commit
        </button>
      </div>
      {strip.error && (
        <p className="architecture-review-state error" role="alert">
          {strip.error}
        </p>
      )}
      {classifications.error !== undefined && (
        <p className="architecture-review-state error">
          Classification failed: {classifications.error}
        </p>
      )}
      {range && (
        <StripCommits
          range={range}
          position={position}
          disabled={disabled}
          stepping={stepping}
          shown={shown}
          classifications={classifications}
          onChoose={choose}
        />
      )}
    </section>
  )
}

function StripCommits({
  range,
  position,
  disabled,
  stepping,
  shown,
  classifications,
  onChoose,
}: {
  readonly range: ArchitectureCommitRange
  readonly position: number
  readonly disabled: boolean
  readonly stepping: StripStepping
  readonly shown: (index: number) => boolean
  readonly classifications: CommitClassificationState
  readonly onChoose: (index: number) => void
}) {
  const listed = range.commits.map((commit, index) => ({ commit, index }))
  const visible = listed.filter(({ index }) => shown(index))
  const classifying = listed.filter(({ commit }) =>
    classifications.pending.has(commit.revision),
  ).length
  return (
    <>
      <p className="architecture-strip-note">
        {range.truncated ? 'Newest ' : ''}
        {range.commits.length} commits after {shortRef(range.base.revision)}, newest first
        {visible.length < listed.length ? `, ${visible.length} shown` : ''}
        {classifying > 0 ? `, ${classifying} classifying` : ''} ·{' '}
        {stepping.kind === 'pairwise'
          ? 'each against its parent'
          : 'each against the held baseline'}
      </p>
      <ol className="architecture-strip-commits">
        {visible.map(({ commit, index }) => (
          <li key={commit.revision}>
            <button
              type="button"
              aria-pressed={index === position}
              title={commit.revision}
              disabled={disabled || !stripEnds(range, index, stepping)}
              onClick={() => onChoose(index)}
            >
              <StripChange
                commit={commit}
                change={classifications.known.get(commit.revision)}
              />
              <span>{commit.subject}</span>
              <small>
                {commitDate(commit.authoredAt)} · <code>{shortRef(commit.revision)}</code>
              </small>
            </button>
          </li>
        ))}
      </ol>
    </>
  )
}

const STRIP_CHANGE_LABELS: Record<ArchitectureCommitChange, string | undefined> = {
  architecture: 'Architecture',
  code: 'Code',
  unclassified: 'Unclassified',
  none: undefined,
}

function StripChange({
  commit,
  change,
}: {
  readonly commit: ArchitectureCommit
  readonly change: ArchitectureCommitChange | undefined
}) {
  const label = commit.merge
    ? 'Merge'
    : change === undefined
      ? undefined
      : STRIP_CHANGE_LABELS[change]
  if (label === undefined) return null
  return (
    <b className={`architecture-strip-change ${commit.merge ? 'merge' : change}`}>
      {label}
    </b>
  )
}

function StripFrom({
  loading,
  onLoad,
}: {
  readonly loading: boolean
  readonly onLoad: (from?: string) => void
}) {
  const [from, setFrom] = useState('')
  const ref = from.trim()
  const problem = ref === '' ? undefined : architectureRefProblem(ref)
  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (problem === undefined) onLoad(ref === '' ? undefined : ref)
  }
  return (
    <form onSubmit={submit}>
      <label>
        Widen from
        <input
          value={from}
          placeholder={ARCHITECTURE_BRANCH_POINT}
          spellCheck={false}
          aria-invalid={problem !== undefined}
          onChange={(event) => setFrom(event.target.value)}
        />
      </label>
      {problem !== undefined && (
        <span className="architecture-review-ref-problem">{problem}</span>
      )}
      <button type="submit" disabled={loading || problem !== undefined}>
        {loading ? 'Listing…' : 'List commits'}
      </button>
    </form>
  )
}

function useCommitRange(root: HostPath) {
  const epoch = useRef(0)
  const [range, setRange] = useState<ArchitectureCommitRange>()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string>()
  const load = useCallback(
    async (from?: string) => {
      const request = ++epoch.current
      setLoading(true)
      setError(undefined)
      try {
        const result = await window.hvir.invoke('architecture-review:commits', {
          root,
          ...(from === undefined ? {} : { from }),
        })
        if (request === epoch.current) setRange(result)
      } catch (cause) {
        if (request === epoch.current)
          setError(
            cause instanceof Error ? cause.message : 'Commits could not be listed.',
          )
      } finally {
        if (request === epoch.current) setLoading(false)
      }
    },
    [root],
  )
  useEffect(() => {
    void load()
    return () => {
      epoch.current += 1
    }
  }, [load])
  return { range, loading, error, load: (from?: string) => void load(from) }
}

function shortRef(ref: string): string {
  return /^[0-9a-f]{40,64}$/.test(ref) ? ref.slice(0, 8) : ref
}
