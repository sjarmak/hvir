const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const DIR = path.join(__dirname, '..')
const read = (file) => fs.readFileSync(path.join(DIR, file), 'utf8')
const pages = fs.readdirSync(DIR).filter((file) => file.endsWith('.html'))
const scripts = fs.readdirSync(DIR).filter((file) => file.endsWith('.js'))

const scriptsOf = (html) => [...html.matchAll(/<script[^>]*\ssrc="([^"]+)"/g)].map((m) => m[1])

const definers = new Map()
for (const file of scripts)
  for (const m of read(file).matchAll(/\bwindow\.([A-Za-z_$][\w$]*)\s*=(?!=)/g))
    definers.set(m[1], [...(definers.get(m[1]) ?? []), file])

const readsOf = (source) => {
  const names = new Set()
  for (const m of source.matchAll(/\bwindow\.([A-Za-z_$][\w$]*)\b(?!\s*=(?!=))/g)) names.add(m[1])
  return names
}

test('there are pages to check', () => {
  assert.ok(pages.length > 0)
})

for (const page of pages)
  test(`${page} loads the module behind every window global its scripts read`, () => {
    const loaded = scriptsOf(read(page))
    loaded.forEach((script, index) => {
      for (const name of readsOf(read(script))) {
        const owners = definers.get(name)
        if (!owners) continue
        const earlier = loaded.slice(0, index + 1)
        assert.ok(
          owners.some((owner) => earlier.includes(owner)),
          `${page}: ${script} reads window.${name}, defined in ${owners.join(', ')}, which is not loaded before it`,
        )
      }
    })
  })
