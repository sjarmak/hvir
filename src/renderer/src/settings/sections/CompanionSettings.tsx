import { useEffect, useState, type ReactElement } from 'react'

import {
  isCompanionPort,
  isCompanionPushUrl,
  type CompanionConfigSave,
  type CompanionConfigView,
} from '../../../../shared'
import { SettingsSection } from '../SettingsSection'
import { useCompanionSettings } from '../use-companion-settings'

interface CompanionDraft {
  readonly enabled: boolean
  readonly port: string
  readonly mirrorInputAllowed: boolean
  readonly pushUrl: string
  readonly pushToken: string
}

function draftOf(view: CompanionConfigView): CompanionDraft {
  return {
    enabled: view.enabled,
    port: String(view.port),
    mirrorInputAllowed: view.mirrorInputAllowed,
    pushUrl: view.push?.url ?? '',
    pushToken: '',
  }
}

function saveOf(draft: CompanionDraft): CompanionConfigSave | string {
  const port = Number(draft.port)
  if (!isCompanionPort(port)) return 'Port must be a whole number between 1024 and 65535.'
  const { enabled, mirrorInputAllowed } = draft
  const url = draft.pushUrl.trim()
  if (url === '') return { enabled, port, mirrorInputAllowed }
  if (!isCompanionPushUrl(url)) {
    return 'The push sink must be an https:// address, or http://127.0.0.1 on this machine.'
  }
  const token = draft.pushToken
  return {
    enabled,
    port,
    mirrorInputAllowed,
    push: token === '' ? { url } : { url, token },
  }
}

function statusText(view: CompanionConfigView | undefined): string {
  if (view === undefined) return 'Reading Companion settings'
  if (view.status.listening)
    return `Listening on 127.0.0.1:${view.status.port ?? view.port}`
  return view.status.error === undefined
    ? 'Not listening'
    : `Not listening: ${view.status.error}`
}

export function CompanionSettings(): ReactElement {
  const companion = useCompanionSettings()
  const { view } = companion
  const [draft, setDraft] = useState<CompanionDraft>()
  const [dirty, setDirty] = useState(false)
  const [localError, setLocalError] = useState<string>()

  useEffect(() => {
    if (view !== undefined && !dirty) setDraft(draftOf(view))
  }, [view, dirty])

  const edit = (patch: Partial<CompanionDraft>): void => {
    setDirty(true)
    setDraft((current) => (current === undefined ? current : { ...current, ...patch }))
  }
  const apply = (request: CompanionConfigSave): void => {
    setLocalError(undefined)
    setDirty(false)
    void companion.save(request)
  }
  const submit = (): void => {
    if (draft === undefined) return
    const request = saveOf(draft)
    if (typeof request === 'string') {
      setLocalError(request)
      return
    }
    apply(request)
  }
  const removeToken = (): void => {
    if (view?.push === undefined) return
    apply({
      enabled: view.enabled,
      port: view.port,
      mirrorInputAllowed: view.mirrorInputAllowed,
      push: { url: view.push.url, token: '' },
    })
  }

  const error = localError ?? companion.error
  const disabled = draft === undefined || companion.busy
  return (
    <SettingsSection
      section="companion"
      title="Companion"
      description="Let a paired phone watch this hvir from another room. The Companion is served only on this machine and pairs once with a code."
    >
      <div className="settings-section-scroll settings-fields">
        <p className="settings-companion-status">{statusText(view)}</p>
        <label htmlFor="settings-companion-enabled" className="settings-checkbox">
          <span>Companion</span>
          <span className="settings-checkbox-control">
            <input
              id="settings-companion-enabled"
              type="checkbox"
              checked={draft?.enabled ?? false}
              disabled={disabled}
              onChange={(event) => edit({ enabled: event.currentTarget.checked })}
            />
            Serve the Companion on this machine
          </span>
        </label>
        <label htmlFor="settings-companion-port">
          <span>Port</span>
          <input
            id="settings-companion-port"
            className="settings-number"
            type="number"
            min={1024}
            max={65535}
            value={draft?.port ?? ''}
            disabled={disabled}
            onChange={(event) => edit({ port: event.currentTarget.value })}
          />
        </label>
        <PairingField view={view} disabled={disabled} companion={companion} />
        <label htmlFor="settings-companion-push-url">
          <span>Push sink</span>
          <input
            id="settings-companion-push-url"
            type="url"
            placeholder="https://ntfy.example/topic"
            value={draft?.pushUrl ?? ''}
            disabled={disabled}
            onChange={(event) => edit({ pushUrl: event.currentTarget.value })}
          />
        </label>
        <label htmlFor="settings-companion-push-token" className="settings-checkbox">
          <span>Push token</span>
          <span className="settings-checkbox-copy">
            <input
              id="settings-companion-push-token"
              type="password"
              autoComplete="off"
              value={draft?.pushToken ?? ''}
              disabled={disabled}
              onChange={(event) => edit({ pushToken: event.currentTarget.value })}
            />
            <small>
              {view?.push?.tokenConfigured
                ? 'Push token set; leave the field blank to keep it.'
                : 'Stored encrypted on this machine and never shown again.'}
            </small>
            {view?.push?.tokenConfigured ? (
              <span className="settings-companion-actions">
                <button type="button" disabled={disabled} onClick={removeToken}>
                  Remove token
                </button>
              </span>
            ) : null}
          </span>
        </label>
        <div className="settings-companion-actions">
          <button type="button" disabled={disabled} onClick={submit}>
            Apply
          </button>
        </div>
        {error === undefined ? null : <p className="dialog-error">{error}</p>}
      </div>
    </SettingsSection>
  )
}

function PairingField({
  view,
  disabled,
  companion,
}: {
  readonly view: CompanionConfigView | undefined
  readonly disabled: boolean
  readonly companion: ReturnType<typeof useCompanionSettings>
}): ReactElement {
  const pairing = view?.pairing
  return (
    <div className="settings-companion-pairing">
      <span>Pairing</span>
      <span className="settings-checkbox-copy">
        {view?.paired ? (
          <small>Paired. Revoking closes every open Companion page.</small>
        ) : pairing === undefined ? (
          <small>
            Not paired. Issue a code and enter it on the phone within ten minutes.
          </small>
        ) : (
          <>
            <code className="settings-companion-code">{pairing.code}</code>
            <small>Expires at {new Date(pairing.expiresAt).toLocaleTimeString()}</small>
          </>
        )}
        <span className="settings-companion-actions">
          {view?.paired ? (
            <button
              type="button"
              disabled={disabled}
              onClick={() => void companion.revokePairing()}
            >
              Revoke pairing
            </button>
          ) : (
            <button
              type="button"
              disabled={disabled}
              onClick={() => void companion.issuePairing()}
            >
              Issue pairing code
            </button>
          )}
        </span>
      </span>
    </div>
  )
}
