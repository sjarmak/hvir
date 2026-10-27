const { test } = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const { JSDOM } = require('jsdom')
const { explainerUrl, scopeCss } = require('../explainer.js')

const attachment = (id, name) => `https://github.com/user-attachments/files/${id}/${name}`

test('the explainer is the html attachment named explainer, else the first html attachment', () => {
  const body = [
    `See [notes.html](${attachment(1, 'notes.html')})`,
    '## PR Explainer HTML',
    `[pr-7-explainer.html](${attachment(2, 'pr-7-explainer.html')})`,
  ].join('\n')
  assert.equal(explainerUrl(body), attachment(2, 'pr-7-explainer.html'))
  assert.equal(explainerUrl(`[a](${attachment(1, 'notes.html')})`), attachment(1, 'notes.html'))
})

test('no html attachment, an image attachment or a lookalike host yields no explainer', () => {
  assert.equal(explainerUrl(undefined), undefined)
  assert.equal(explainerUrl('https://github.com/user-attachments/assets/39126a61-1d80'), undefined)
  assert.equal(explainerUrl(attachment(1, 'clip.mp4')), undefined)
  assert.equal(explainerUrl('https://github.com.evil.test/user-attachments/files/1/x.html'), undefined)
  assert.equal(explainerUrl(`${attachment(1, 'x.html')}/../../repos`), undefined)
})

test('document selectors are scoped to the shadow host and the body wrapper', () => {
  assert.equal(
    scopeCss(':root { --ink: red; }\n@media (prefers-color-scheme: dark) { :root { --ink: blue; } }\nhtml { color: var(--ink); }\nbody { margin: 0; }\n.body-copy, tbody { x: 1; }'),
    ':host { --ink: red; }\n@media (prefers-color-scheme: dark) { :host { --ink: blue; } }\n:host { color: var(--ink); }\n.explainer-body { margin: 0; }\n.body-copy, tbody { x: 1; }',
  )
})

test('mounting keeps styles and diagrams, drops scripts and handlers, and turns the video into its poster', () => {
  const dom = new JSDOM('<div id="host"></div>', { runScripts: 'outside-only' })
  const { window } = dom
  window.eval(readFileSync(join(__dirname, '../vendor/purify.min.js'), 'utf8'))
  window.eval(readFileSync(join(__dirname, '../explainer.js'), 'utf8'))
  const html = `<!doctype html><html><head><style>:root { --ink: red; } body { margin: 0; }</style></head><body>
    <h1 onclick="alert(1)">Title</h1><script>window.ran = true</script>
    <svg viewBox="0 0 10 10"><rect width="5" height="5"></rect></svg>
    <video controls poster="data:image/jpeg;base64,AAAA"><source src="data:video/mp4;base64,AAAA"></video>
    <a href="https://example.com">x</a></body></html>`
  const host = window.document.getElementById('host')
  window.explainer.mount(host, html)
  const root = host.shadowRoot
  assert.match(root.querySelector('style').textContent, /:host \{ --ink: red; \} \.explainer-body \{ margin: 0; \}/)
  assert.equal(root.querySelector('h1').textContent, 'Title')
  assert.equal(root.querySelector('h1').hasAttribute('onclick'), false)
  assert.equal(root.querySelector('script'), null)
  assert.equal(window.ran, undefined)
  assert.ok(root.querySelector('svg rect'))
  assert.equal(root.querySelector('video'), null)
  assert.equal(root.querySelector('.explainer-video img').getAttribute('src'), 'data:image/jpeg;base64,AAAA')
  assert.equal(root.querySelector('a').title, 'https://example.com')
  window.explainer.mount(host, '<p>again</p>')
  assert.equal(root.querySelectorAll('.explainer-body').length, 1)
})
