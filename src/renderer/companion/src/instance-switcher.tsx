import { useEffect, useMemo, useState } from 'react'

import {
  COMPANION_INSTANCE_LINKS_KEY,
  addCompanionInstanceLink,
  canonicalCompanionEndpoint,
  companionInstanceStorage,
  readCompanionInstanceLinks,
  removeCompanionInstanceLink,
  renameCompanionInstanceLink,
  writeCompanionInstanceLinks,
  type CompanionInstanceLink,
} from './companion-instance-links'

interface InstanceSwitcherProps {
  readonly currentUrl?: string
  readonly onLeave?: () => void
  readonly collapsible?: boolean
}

export function InstanceSwitcher({
  currentUrl = globalThis.location.href,
  onLeave,
  collapsible = false,
}: InstanceSwitcherProps) {
  const storage = companionInstanceStorage()
  const endpoint = useMemo(() => safeEndpoint(currentUrl), [currentUrl])
  const [result, setResult] = useState(() =>
    storage === undefined
      ? {
          status: 'error' as const,
          message: 'Browser storage is unavailable; saved links cannot be used.',
        }
      : readCompanionInstanceLinks(storage),
  )
  const [writeError, setWriteError] = useState<string>()
  const [name, setName] = useState('')
  const [url, setUrl] = useState(endpoint)
  const [validationError, setValidationError] = useState<string>()
  const [editing, setEditing] = useState<string>()
  const [editingName, setEditingName] = useState('')
  const links = result.status === 'ok' ? result.links : []

  useEffect(() => {
    if (storage !== undefined) setResult(readCompanionInstanceLinks(storage))
  }, [storage])

  function saveCurrent(): void {
    if (storage === undefined || result.status !== 'ok' || name.trim() === '') return
    try {
      const link: CompanionInstanceLink = {
        id: createId(),
        name: name.trim(),
        url: canonicalCompanionEndpoint(url),
      }
      setValidationError(undefined)
      const written = addCompanionInstanceLink(storage, link, result.links)
      if (written.status === 'saved') {
        setWriteError(undefined)
        setResult({ status: 'ok', links: written.links })
      } else {
        setWriteError(written.message)
        return
      }
    } catch (error: unknown) {
      setValidationError(error instanceof Error ? error.message : String(error))
      return
    }
    setName('')
    setUrl(endpoint)
  }

  function rename(id: string): void {
    if (storage === undefined || result.status !== 'ok' || editingName.trim() === '')
      return
    const written = writeCompanionInstanceLinks(
      storage,
      renameCompanionInstanceLink(result.links, id, editingName),
    )
    if (written.status === 'saved') {
      setWriteError(undefined)
      setResult({ status: 'ok', links: written.links })
    } else setWriteError(written.message)
    setEditing(undefined)
    setEditingName('')
  }

  function remove(id: string): void {
    if (storage === undefined || result.status !== 'ok') return
    const written = writeCompanionInstanceLinks(
      storage,
      removeCompanionInstanceLink(result.links, id),
    )
    if (written.status === 'saved') {
      setWriteError(undefined)
      setResult({ status: 'ok', links: written.links })
    } else setWriteError(written.message)
  }

  function recoverStorage(): void {
    if (storage === undefined) return
    try {
      storage.removeItem(COMPANION_INSTANCE_LINKS_KEY)
      setResult({ status: 'ok', links: [] })
    } catch {
      setResult({
        status: 'error',
        message: 'Saved Companion links could not be removed. Check browser storage.',
      })
    }
  }

  const contents = (
    <>
      <p className="companion-instance-current">
        Current endpoint: <code>{endpoint}</code>
      </p>
      <details>
        <summary>Switch Companion instance</summary>
        <div className="companion-instance-panel">
          <p className="companion-hint">
            Saved links stay on this browser and this address, and pair independently.
            Opening one navigates to that hvir instance.
          </p>
          <p className="companion-hint">
            Use the browser Back button to return here; the other instance may require
            pairing again.
          </p>
          {result.status === 'error' ? (
            <div className="companion-error" role="alert">
              <span>{result.message}</span>
              <button type="button" className="companion-button" onClick={recoverStorage}>
                Remove saved links
              </button>
            </div>
          ) : (
            <>
              {writeError === undefined ? null : (
                <p className="companion-error" role="alert">
                  {writeError}
                </p>
              )}
              <form
                className="companion-instance-save"
                onSubmit={(event) => {
                  event.preventDefault()
                  saveCurrent()
                }}
              >
                <label className="companion-label" htmlFor="companion-instance-name">
                  Save an endpoint as
                </label>
                <div className="companion-instance-row">
                  <input
                    id="companion-instance-name"
                    className="companion-input"
                    value={name}
                    maxLength={80}
                    onChange={(event) => setName(event.target.value)}
                    placeholder="Office hvir"
                  />
                  <input
                    className="companion-input"
                    value={url}
                    aria-label="Companion endpoint URL"
                    onChange={(event) => setUrl(event.target.value)}
                  />
                  <button
                    type="submit"
                    className="companion-button"
                    disabled={name.trim() === ''}
                  >
                    Save
                  </button>
                </div>
                {validationError === undefined ? null : (
                  <p className="companion-error" role="alert">
                    {validationError}
                  </p>
                )}
              </form>
              {links.length === 0 ? (
                <p className="companion-empty">No saved hvir instances.</p>
              ) : (
                <ul className="companion-instance-links">
                  {links.map((link) => (
                    <li key={link.id} className="companion-instance-link">
                      {editing === link.id ? (
                        <form
                          className="companion-instance-row"
                          onSubmit={(event) => {
                            event.preventDefault()
                            rename(link.id)
                          }}
                        >
                          <input
                            className="companion-input"
                            value={editingName}
                            maxLength={80}
                            onChange={(event) => setEditingName(event.target.value)}
                            aria-label={`Rename ${link.name}`}
                          />
                          <button type="submit" className="companion-button">
                            Save
                          </button>
                          <button
                            type="button"
                            className="companion-button"
                            onClick={() => setEditing(undefined)}
                          >
                            Cancel
                          </button>
                        </form>
                      ) : (
                        <>
                          <span className="companion-instance-link-detail">
                            <strong>{link.name}</strong>
                            <code>{link.url}</code>
                          </span>
                          <a
                            className="companion-button companion-instance-open"
                            href={link.url}
                            referrerPolicy="no-referrer"
                            onClick={(event) => {
                              if (
                                event.button === 0 &&
                                !event.metaKey &&
                                !event.ctrlKey &&
                                !event.shiftKey &&
                                !event.altKey
                              ) {
                                onLeave?.()
                              }
                            }}
                          >
                            Open
                          </a>
                          <button
                            type="button"
                            className="companion-button"
                            onClick={() => {
                              setEditing(link.id)
                              setEditingName(link.name)
                            }}
                          >
                            Rename
                          </button>
                          <button
                            type="button"
                            className="companion-button"
                            onClick={() => remove(link.id)}
                          >
                            Remove
                          </button>
                        </>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </div>
      </details>
    </>
  )

  if (collapsible) {
    return (
      <details className="companion-instance-switcher">
        <summary>Companion instance</summary>
        {contents}
      </details>
    )
  }

  return <section className="companion-instance-switcher">{contents}</section>
}

function safeEndpoint(value: string): string {
  try {
    return canonicalCompanionEndpoint(value)
  } catch {
    return `${globalThis.location.origin}/`
  }
}

function createId(): string {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `${Date.now()}-${Math.random().toString(36).slice(2)}`
  )
}
