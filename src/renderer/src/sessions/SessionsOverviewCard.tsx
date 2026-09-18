import { useState, type ReactElement } from 'react'

import type { SessionsProjectionRow } from '../../../shared'
import { ProviderContextMeter } from '../harness/ProviderContextMeter'
import {
  sessionsOverviewCardFacts,
  sessionsOverviewCardIdentity,
  type SessionsOverviewGroup,
  type SessionsOverviewCardFact,
} from './sessions-overview-model'

export function SessionsOverviewCard({
  row,
  group,
  opening,
  onOpen,
  onInteract,
  onForget,
  onRename,
}: {
  readonly row: SessionsProjectionRow
  readonly group: SessionsOverviewGroup
  readonly opening: boolean
  readonly onOpen?: () => void
  readonly onInteract?: () => void
  readonly onForget?: () => void
  readonly onRename?: (title: string) => void
}): ReactElement {
  const presentation = sessionsOverviewCardFacts(row)
  const identity = sessionsOverviewCardIdentity(row, group)
  const [renaming, setRenaming] = useState<string>()
  const commitRename = (): void => {
    if (renaming === undefined) return
    onRename?.(renaming)
    setRenaming(undefined)
  }
  return (
    <>
      <header>
        <div className="session-card-identity">
          <span className={`session-kind ${row.provider.kind}`}>{identity.label}</span>
          {renaming !== undefined ? (
            <input
              type="text"
              className="session-card-rename-input"
              value={renaming}
              autoFocus
              onChange={(event) => setRenaming(event.currentTarget.value)}
              onBlur={commitRename}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  commitRename()
                } else if (event.key === 'Escape') {
                  event.preventDefault()
                  setRenaming(undefined)
                }
              }}
            />
          ) : (
            <h3>{identity.title}</h3>
          )}
        </div>
      </header>
      {row.context.status === 'available' || row.context.status === 'stale' ? (
        <ProviderContextMeter
          contextFacet={row.context}
          pressurePolicy={row.provider.contextPressure}
        />
      ) : null}
      <footer className="session-card-footer">
        <dl className="session-facts">
          {presentation.facts.map((fact) => (
            <Fact key={fact.label} fact={fact} />
          ))}
        </dl>
        <div className="session-card-actions">
          {onRename ? (
            <button
              type="button"
              onClick={() => setRenaming(row.title)}
              aria-label={`Rename ${identity.title}`}
            >
              Rename
            </button>
          ) : null}
          {onForget ? (
            <button
              type="button"
              className="session-card-forget"
              onClick={onForget}
              aria-label={`Forget ${identity.title}`}
            >
              Forget
            </button>
          ) : null}
          {onInteract ? (
            <button type="button" onClick={onInteract}>
              Interact
            </button>
          ) : null}
          {onOpen ? (
            <button type="button" disabled={opening} onClick={onOpen}>
              {opening ? 'Opening…' : 'Open'}
            </button>
          ) : null}
        </div>
      </footer>
    </>
  )
}

function Fact({ fact }: { readonly fact: SessionsOverviewCardFact }): ReactElement {
  return (
    <div
      className={`session-fact ${fact.tone}${fact.label === 'Status' ? ' status activity' : fact.label === 'Attention' || fact.label === 'Working' ? ' activity' : ''}`}
    >
      <dt>{fact.label}</dt>
      <dd>
        {fact.value}
        {fact.detail === undefined ? null : (
          <>
            {': '}
            <span className="session-fact-detail">{fact.detail}</span>
          </>
        )}
      </dd>
    </div>
  )
}
