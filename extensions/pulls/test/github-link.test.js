const { test } = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const { JSDOM } = require('jsdom')

function loadView() {
  const { window } = new JSDOM('<div id="row"></div>', { runScripts: 'outside-only' })
  const requests = []
  window.hvirExtension = { onMessage: () => () => {}, send: () => {} }
  window.host = { request: (capability, input) => (requests.push([capability, input]), Promise.resolve(null)) }
  window.eval(readFileSync(join(__dirname, '../view.js'), 'utf8'))
  return { window, requests }
}

test('the GitHub link appears only when hvir grants viewer.open-external', () => {
  const { window } = loadView()
  assert.equal(window.githubLink('https://github.com/acme/widgets/pull/7', () => {}), null)
  window.grantedCapabilities = new Set(['viewer.open-external'])
  assert.equal(window.githubLink('https://github.com/acme/widgets/pull/7', () => {}).textContent, '↗ GitHub')
})

test('activating the link asks hvir to open the url without also activating the row', () => {
  const { window, requests } = loadView()
  window.grantedCapabilities = new Set(['viewer.open-external'])
  const row = window.document.getElementById('row')
  let rowClicks = 0
  row.addEventListener('click', () => (rowClicks += 1))
  const link = window.githubLink('https://github.com/acme/widgets/pull/7', () => {})
  row.append(link)
  link.click()
  link.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  assert.equal(rowClicks, 0)
  assert.deepEqual(JSON.parse(JSON.stringify(requests)), [
    ['viewer.open-external', { url: 'https://github.com/acme/widgets/pull/7' }],
    ['viewer.open-external', { url: 'https://github.com/acme/widgets/pull/7' }],
  ])
})
