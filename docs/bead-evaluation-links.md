# Exact evaluation links on Beads

Expanded Bead details show an exact run/result link when its producer supplies
`eval.run_url` in the existing flat Beads metadata. This is distinct from the
rolling Honeycomb discovery link and rig-filtered Omni dashboard.

The producer owns the destination and facts. hvir does not fetch the result,
discover runs, scan private artifacts, score evaluations, or establish that the
result applies to the current workspace. The link opens in the system browser
using the existing external-link policy and the browser's own authentication.
Never put credentials or signed secret-bearing URLs in metadata.

| Key | Value |
| --- | --- |
| `eval.run_url` | Required exact HTTPS URL, at most 2,048 characters, no embedded username/password, controls, or backslashes |
| `eval.run_id` | Optional producer's run identifier |
| `eval.candidate_sha` | Optional full 40- or 64-character hexadecimal Git object ID |
| `eval.baseline_sha` | Optional full 40- or 64-character hexadecimal Git object ID |
| `eval.model` | Optional producer's model identity |
| `eval.config` | Optional producer's configuration or prompt-set identity |
| `eval.recorded_at` | Optional UTC timestamp, `YYYY-MM-DDTHH:mm:ssZ` or with three fractional-second digits |

Optional facts are bounded to 256 characters each. Invalid supplied facts are
named as invalid, not silently substituted. An invalid or missing URL produces
an unavailable message, not a link. Missing facts remain unknown. These are run
facts, never evidence of a session's effective environment or launch profile.

For Omni's native AI Hub, supply the full organization URL ending in
`/ai-hub/eval-runs/{runId}`. Other projects can supply their own exact HTTPS
result destination. Local private manifests are not automatically exposed.

The metadata travels through the existing local or SSH Beads read, so hvir adds
no host access, polling, persistence, or producer integration for this feature.
