interface MirrorHeaderProps {
  readonly title: string
  /** The row's prompt message while it lasts (ADR-051), as the header's second line. */
  readonly promptBody: string | undefined
  /** The row also takes answers, so its transcript is one tap away. */
  readonly offersTranscript: boolean
  readonly onBack: () => void
  readonly onTranscript: () => void
}

/** One line over the mirror: back, the row's title, and the transcript when offered. */
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
