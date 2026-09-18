/**
 * The plain sentences a pane says about a transcript it cannot show or a
 * mutation that did not happen. The desktop's Sessions detail and the
 * Companion phone page read the same reason codes, so they say the same thing.
 */
import type {
  SessionsMutationUnavailableReason,
  SessionsTranscriptUnavailableReason,
} from './sessions-transcript'

/** What a pane says about a transcript it cannot show. */
export function sessionsTranscriptUnavailableMessage(
  reason: SessionsTranscriptUnavailableReason,
): string {
  switch (reason) {
    case 'not-projected':
      return 'This session is no longer in the current Sessions view.'
    case 'stale-projection':
      return 'Sessions changed. Reopen the refreshed row to read its transcript.'
    case 'city-unknown':
      return 'No city on this host answers for that session.'
    case 'disabled':
      return 'The Gas City supervisor surface is turned off for this host.'
    case 'misconfigured':
      return 'The configured supervisor endpoint could not be read as one.'
    case 'unreachable':
      return 'The Gas City supervisor is not reachable on this host.'
    case 'timeout':
      return 'The Gas City supervisor did not answer in time.'
    case 'aborted':
      return 'The transcript request ended before it was answered.'
    case 'protocol':
      return 'The supervisor answered with something this build does not understand.'
    case 'not-found':
      return 'The supervisor no longer holds this session.'
    case 'denied':
      return 'The supervisor refused the request.'
    case 'conflict':
      return 'The supervisor reports the session in a conflicting state.'
    case 'rejected':
      return 'The supervisor rejected the request.'
    case 'unsupported':
      return 'This supervisor does not serve transcripts.'
    case 'unready':
      return 'The city backend is not serving transcripts yet.'
    case 'faulted':
      return 'The supervisor reported a fault reading this transcript.'
  }
}

/** What a pane says about a mutation that did not happen. */
export function sessionsMutationUnavailableMessage(
  reason: SessionsMutationUnavailableReason,
): string {
  switch (reason) {
    case 'stale-interaction':
      return 'That prompt changed before the answer was sent. Read the new one.'
    case 'no-interaction':
      return 'This session is not waiting on an answer.'
    case 'invalid-option':
      return 'That answer is no longer one of the options.'
    case 'invalid-message':
      return 'A message has to have text in it, and fit inside one message.'
    default:
      return sessionsTranscriptUnavailableMessage(reason)
  }
}
