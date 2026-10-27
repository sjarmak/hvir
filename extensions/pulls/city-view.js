/* global window */
window.cityView = (() => {
  const { el } = window
  const city = window.cityReviews
  const follow = window.cityFollowups
  const UNKNOWN = 'not recorded'
  const SEVERITY_TONES = { blocking: 'danger', important: 'warning', major: 'warning' }

  function toned(label, tone, className = 'chip') {
    const node = el('span', { className }, label)
    node.dataset.tone = tone
    return node
  }

  const shortSha = (sha) => (sha ? sha.slice(0, 12) : '')

  function link(url, onStatus) {
    return el(
      'span',
      { className: 'selectable city-link' },
      url,
      ' ',
      window.githubLink(url, onStatus) ?? '',
    )
  }

  function fact(label, value) {
    const empty = value === undefined || value === null || value === ''
    return [
      el('dt', {}, label),
      el('dd', { className: empty ? 'hvir-meta' : '' }, empty ? UNKNOWN : value),
    ]
  }

  function headNote(run, headOid) {
    if (!run.reviewedHead) return ''
    const short = shortSha(run.reviewedHead)
    if (!headOid) return short
    return headOid.startsWith(run.reviewedHead) || run.reviewedHead.startsWith(headOid)
      ? `${short} (current head)`
      : `${short} (older than the current head ${shortSha(headOid)})`
  }

  function laneTable(lanes) {
    return el(
      'table',
      { className: 'city-lanes' },
      el(
        'thead',
        {},
        el(
          'tr',
          {},
          ...['Lane', 'LLM', 'Verdict', 'Blocking', 'Summary'].map((head) =>
            el('th', {}, head),
          ),
        ),
      ),
      el(
        'tbody',
        {},
        ...lanes.map((lane) =>
          el(
            'tr',
            {},
            el('td', {}, lane.lane),
            el('td', {}, lane.model || UNKNOWN),
            el(
              'td',
              {},
              toned(city.verdictLabel(lane.verdict), city.verdictTone(lane.verdict)),
            ),
            el('td', {}, lane.blocking === undefined ? '' : String(lane.blocking)),
            el(
              'td',
              {},
              lane.unreadable
                ? el('span', { className: 'hvir-meta' }, `unreadable: ${lane.unreadable}`)
                : el(
                    'details',
                    {},
                    el('summary', {}, `${lane.findings} findings`),
                    el('p', { className: 'selectable' }, lane.summary),
                  ),
            ),
          ),
        ),
      ),
    )
  }

  function findingItem(finding, { onJump, onStatus }) {
    const where = finding.file
      ? `${finding.file}${finding.line ? `:${finding.line}` : ''}`
      : 'no file'
    const jump = el(
      'button',
      { className: 'hvir-button link-button', type: 'button', disabled: !finding.file },
      where,
    )
    jump.addEventListener('click', () => onJump(finding.file, finding.line))
    return el(
      'li',
      { className: 'city-finding' },
      el(
        'div',
        { className: 'chips' },
        toned(finding.severity, SEVERITY_TONES[finding.severity] ?? 'neutral'),
        el('strong', {}, finding.title),
      ),
      el(
        'div',
        { className: 'hvir-meta chips' },
        jump,
        finding.lanes.length
          ? el('span', {}, `found by ${finding.lanes.join(', ')}`)
          : null,
        finding.postedUrl ? el('span', {}, 'posted') : el('span', {}, 'not posted'),
        finding.postedUrl ? window.githubLink(finding.postedUrl, onStatus) : null,
      ),
      finding.evidence
        ? el(
            'details',
            {},
            el('summary', {}, 'Evidence'),
            window.markdown.render(finding.evidence),
          )
        : null,
    )
  }

  function packageSection(loaded, handlers) {
    if (!loaded)
      return [el('p', { className: 'hvir-meta' }, 'Loading the review package…')]
    if (loaded.unavailable)
      return [el('p', { className: 'hvir-meta' }, loaded.unavailable)]
    if (loaded.error)
      return [
        el(
          'p',
          { className: 'hvir-meta' },
          `Review package unavailable: ${loaded.error}`,
        ),
      ]
    const { pkg } = loaded
    const [latest, ...older] = pkg.rounds
    return [
      latest
        ? el('h4', {}, `Round ${latest.round} lanes`)
        : el('p', { className: 'hvir-meta' }, 'No lane results recorded.'),
      latest ? laneTable(latest.lanes) : null,
      ...older.map((round) =>
        el(
          'details',
          {},
          el('summary', {}, `Round ${round.round} lanes`),
          laneTable(round.lanes),
        ),
      ),
      el('h4', {}, `Consolidated findings · ${pkg.findings.length}`),
      pkg.findings.length
        ? el(
            'ul',
            { className: 'city-findings' },
            ...pkg.findings.map((finding) => findingItem(finding, handlers)),
          )
        : el('p', { className: 'hvir-meta' }, 'No findings.'),
      pkg.gate?.checks?.length
        ? el(
            'details',
            {},
            el('summary', {}, `Gate ${pkg.gate.result ?? ''}`),
            el(
              'ul',
              {},
              ...pkg.gate.checks.map((check) =>
                el(
                  'li',
                  {},
                  `${check.ok ? '✓' : '✗'} ${check.id}: ${check.detail ?? ''}`,
                ),
              ),
            ),
          )
        : null,
    ].filter(Boolean)
  }

  function runArticle(run, loaded, { headOid, ...handlers }) {
    const heading =
      run.kind === 'review'
        ? `Review of a colleague's PR · ${run.id}`
        : `Written by the city pipeline · ${run.id}`
    const posted = [
      ...run.posted,
      ...(loaded?.pkg?.posted ?? []).map((entry) => entry.url),
    ]
    const lanes =
      run.lanes ||
      loaded?.pkg?.rounds?.[0]?.lanes
        .map((lane) => `${lane.lane}: ${lane.model || UNKNOWN}`)
        .join(', ')
    return el(
      'article',
      { className: 'city-run' },
      el('h3', {}, heading),
      el(
        'div',
        { className: 'chips' },
        toned(city.verdictLabel(run.verdict), city.verdictTone(run.verdict)),
        run.blocking ? toned(`${run.blocking} blocking`, 'danger') : null,
        el('span', { className: 'chip' }, run.status),
        run.round ? el('span', { className: 'chip' }, `round ${run.round}`) : null,
        run.tier ? el('span', { className: 'chip' }, `tier ${run.tier}`) : null,
        run.gate ? el('span', { className: 'chip' }, `gate ${run.gate}`) : null,
      ),
      el(
        'dl',
        { className: 'city-facts' },
        ...fact('Reviewed commit', headNote(run, headOid)),
        ...fact(
          'Reviewed at',
          run.reviewedAt
            ? `${new Date(run.reviewedAt).toLocaleString()} (${window.ago(run.reviewedAt)})`
            : '',
        ),
        ...fact('Formula', run.formula),
        ...fact('Seat', run.seat),
        ...fact('LLMs', lanes),
        ...fact('Decision', run.decision),
        ...fact(
          'Posted',
          posted.length
            ? el(
                'div',
                {},
                ...[...new Set(posted)].map((url) => link(url, handlers.onStatus)),
              )
            : '',
        ),
      ),
      ...packageSection(loaded, handlers),
    )
  }

  function runsSection(data, handlers) {
    if (data.error)
      return [el('p', { className: 'hvir-meta' }, `City reviews unavailable: ${data.error}`)]
    if (data.unavailable) return [el('p', { className: 'hvir-meta' }, data.unavailable)]
    if (data.runs.length === 0)
      return [
        el(
          'p',
          { className: 'hvir-meta' },
          'No city pipeline run or review is recorded for this pull request.',
        ),
      ]
    return data.runs.map((run, index) => {
      const article = runArticle(run, data.packages.get(run.id), handlers)
      return index === 0
        ? article
        : el(
            'details',
            { className: 'city-older' },
            el('summary', {}, `Earlier: ${run.title}`),
            article,
          )
    })
  }

  function followupItem(followup, headOid) {
    const detail =
      followup.kind === 'ci'
        ? `at ${headNote({ reviewedHead: followup.head }, headOid) || UNKNOWN}`
        : followup.kind === 'comments'
          ? `${followup.comments} comment${followup.comments === 1 ? '' : 's'}`
          : ''
    return el(
      'li',
      { className: 'city-finding' },
      el(
        'div',
        { className: 'chips' },
        toned(follow.kindLabel(followup.kind), follow.isOpen(followup) ? 'warning' : 'neutral'),
        el('span', { className: 'chip' }, followup.status),
        el('strong', {}, followup.title),
      ),
      el(
        'div',
        { className: 'hvir-meta chips' },
        el('span', { className: 'selectable' }, followup.id),
        detail ? el('span', {}, detail) : null,
        followup.updatedAt ? el('span', {}, `updated ${window.ago(followup.updatedAt)}`) : null,
      ),
    )
  }

  function followupsSection(data, headOid) {
    const found = data.followups
    if (!found) return []
    if (found.error)
      return [el('h3', {}, 'City follow-ups'), el('p', { className: 'hvir-meta' }, `City follow-ups unavailable: ${found.error}`)]
    if (found.unavailable || found.followups.length === 0) return []
    const open = found.followups.filter(follow.isOpen)
    const closed = found.followups.filter((item) => !follow.isOpen(item))
    return [
      el('h3', {}, `City follow-ups · ${open.length} open`),
      open.length
        ? el('ul', { className: 'city-findings' }, ...open.map((item) => followupItem(item, headOid)))
        : el('p', { className: 'hvir-meta' }, 'Nothing open.'),
      closed.length
        ? el(
            'details',
            {},
            el('summary', {}, `${closed.length} closed`),
            el('ul', { className: 'city-findings' }, ...closed.map((item) => followupItem(item, headOid))),
          )
        : null,
    ].filter(Boolean)
  }

  function render(root, data, handlers) {
    root.replaceChildren(
      el('h2', {}, 'City reviews'),
      ...runsSection(data, handlers),
      ...followupsSection(data, handlers.headOid),
    )
  }

  function findingBlock(finding) {
    return el(
      'div',
      { className: 'city-inline' },
      el(
        'span',
        { className: 'hvir-meta' },
        toned(finding.severity, SEVERITY_TONES[finding.severity] ?? 'neutral'),
        ` City finding ${finding.id}${finding.lanes.length ? ` · ${finding.lanes.join(', ')}` : ''}${finding.postedUrl ? ' · posted' : ''}`,
      ),
      el('strong', {}, finding.title),
      finding.evidence
        ? el(
            'details',
            {},
            el('summary', {}, 'Evidence'),
            window.markdown.render(finding.evidence),
          )
        : null,
    )
  }

  return Object.freeze({ render, findingBlock })
})()
