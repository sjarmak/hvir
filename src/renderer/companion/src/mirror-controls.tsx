import { useState, type FormEvent } from 'react'

import { COMPANION_KEYS } from './companion-keys'
import type { CompanionInputArmingControl } from './use-input-arming'

interface MirrorControlsProps {
  readonly live: boolean
  readonly arming: CompanionInputArmingControl
  readonly onInput: (data: string) => Promise<void>
}

/**
 * The bar under the mirror (ADR-050): the arm control alone while disarmed;
 * while armed, the keys a phone keyboard lacks in one strip that scrolls
 * sideways, and free text with Send on a second row. An arming is bound to
 * the live mirror, so `armed` already implies `live`.
 */
export function MirrorControls({ live, arming, onInput }: MirrorControlsProps) {
  const { armed } = arming
  return (
    <div className="companion-mirror-controls">
      <div className="companion-mirror-controls-row">
        <button
          type="button"
          className="companion-button companion-button-compact companion-arm"
          data-armed={armed ? 'true' : 'false'}
          aria-pressed={armed}
          disabled={!live}
          onClick={armed ? arming.disarm : arming.arm}
        >
          {armed ? 'Disarm' : 'Arm typing'}
        </button>
        {armed ? (
          <div className="companion-keys">
            {COMPANION_KEYS.map((key) => (
              <button
                key={key.label}
                type="button"
                className="companion-button companion-button-compact companion-key"
                onClick={() => void onInput(key.data)}
              >
                {key.label}
              </button>
            ))}
          </div>
        ) : null}
      </div>
      {armed ? <TerminalTextForm onInput={onInput} /> : null}
    </div>
  )
}

/** Free text: Send posts it as typed; the keyboard's return posts it with Enter. */
function TerminalTextForm({
  onInput,
}: {
  readonly onInput: (data: string) => Promise<void>
}) {
  const [text, setText] = useState('')

  async function send(data: string): Promise<void> {
    if (data === '') return
    setText('')
    await onInput(data)
  }

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    void send(`${text}\r`)
  }

  return (
    <form className="companion-terminal-form" onSubmit={submit}>
      <input
        id="companion-terminal-text"
        className="companion-input"
        type="text"
        autoComplete="off"
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        value={text}
        onChange={(event) => setText(event.target.value)}
      />
      <button
        type="button"
        className="companion-button companion-button-compact companion-button-primary"
        disabled={text === ''}
        onClick={() => void send(text)}
      >
        Send
      </button>
    </form>
  )
}
