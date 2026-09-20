import { COMPANION_TEXT_SIZES } from './companion-text-size'

interface MirrorHeaderProps {
  readonly title: string
  /** The row's prompt message while it lasts (ADR-051), as the header's second line. */
  readonly promptBody: string | undefined
  /** The row also takes answers, so its transcript is one tap away. */
  readonly offersTranscript: boolean
  readonly onBack: () => void
  readonly onTranscript: () => void
  /** The mirror's current text size in CSS pixels (ADR-059). */
  readonly textSize: number
  readonly onTextSize: (direction: 1 | -1) => void
}

const SMALLEST_TEXT = COMPANION_TEXT_SIZES[0] ?? 0
const LARGEST_TEXT = COMPANION_TEXT_SIZES[COMPANION_TEXT_SIZES.length - 1] ?? 0

/**
 * One line over the mirror: back, the row's title, the two steps of the text
 * size, and the transcript when offered. The size lives here rather than in a
 * settings screen because what it changes is on screen behind it: a step
 * redraws the mirror at a new density and the phone holds the session at the
 * grid that density earns (ADR-059), which is a thing to judge by eye.
 */
export function MirrorHeader(props: MirrorHeaderProps) {
  return (
    <header className="companion-mirror-header">
      <button
        type="button"
        className="companion-button companion-button-compact companion-back"
        onClick={props.onBack}
      >
        Sessions
      </button>
      <h2 className="companion-mirror-title">{props.title}</h2>
      <div className="companion-text-size">
        <button
          type="button"
          className="companion-button companion-button-compact"
          aria-label="Smaller text"
          disabled={props.textSize <= SMALLEST_TEXT}
          onClick={() => props.onTextSize(-1)}
        >
          A-
        </button>
        <button
          type="button"
          className="companion-button companion-button-compact"
          aria-label="Larger text"
          disabled={props.textSize >= LARGEST_TEXT}
          onClick={() => props.onTextSize(1)}
        >
          A+
        </button>
      </div>
      {props.offersTranscript ? (
        <button
          type="button"
          className="companion-button companion-button-compact"
          onClick={props.onTranscript}
        >
          Transcript
        </button>
      ) : null}
      {props.promptBody === undefined ? null : (
        <p className="companion-mirror-prompt" role="status">
          {props.promptBody}
        </p>
      )}
    </header>
  )
}
