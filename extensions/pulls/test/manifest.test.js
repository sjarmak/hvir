const { test } = require('node:test')
const assert = require('node:assert/strict')
const manifest = require('../hvir-extension.json')

/** hvir rejects the whole package past these (src/shared/extensions/connectors.ts, contributions.ts). */
const CONNECTOR_DESCRIPTION = 240
const ACTION_DESCRIPTION = 500

test('connector and action descriptions fit hvir manifest limits', () => {
  for (const connector of manifest.connectors ?? [])
    assert.ok(
      connector.description.length <= CONNECTOR_DESCRIPTION,
      `${connector.id}: ${connector.description.length} chars`,
    )
  for (const action of manifest.actions ?? [])
    assert.ok(
      action.description.length <= ACTION_DESCRIPTION,
      `${action.id}: ${action.description.length} chars`,
    )
})
