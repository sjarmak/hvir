import json
import shutil
import subprocess
from pathlib import Path

from hypothesis import example, given, settings, strategies as st

ROOT = Path(__file__).resolve().parents[3]
NODE = shutil.which('node')
if NODE is None:
    raise RuntimeError('answer properties require Node on PATH')
DEPENDENCIES = subprocess.run(
    [NODE, '-e', "require('jsdom')"], cwd=ROOT, text=True, capture_output=True, check=False,
)
if DEPENDENCIES.returncode:
    raise RuntimeError('answer properties require jsdom; set NODE_PATH to the installed node_modules directory\n'
                       + DEPENDENCIES.stderr)
SCRIPT = """
const fs = require('node:fs')
const vm = require('node:vm')
const assert = require('node:assert/strict')
const window = {
  needsModel: require('./extensions/gascity/needs-model.js'),
  hvirExtension: { onMessage: (listen) => listen({ kind: 'hello', capabilities: ['connector.action-binding'] }) },
  host: { run: () => assert.fail('invalid input dispatched') },
}
vm.runInNewContext(fs.readFileSync('extensions/gascity/answer.js', 'utf8'), { window })
window.answerAction.handle({ send: (reply) => {
  assert.equal(reply.value?.notSent, true)
  assert.equal(reply.value.line, 'No answer was sent: The answer needs a decision id, one letter and the card hash')
} }, { id: 'inv-1', input: JSON.parse(fs.readFileSync(0, 'utf8')), context: { workspace: { id: 'ws-1' } } })
  .catch((error) => { console.error(error); process.exitCode = 1 })
"""


@settings(max_examples=100, deadline=None, database=None, derandomize=True)
@example(letter='')
@given(letter=st.text().filter(lambda value: len(value) != 1))
def invalid_letters_are_retryable_without_dispatch(letter):
    result = subprocess.run(
        [NODE, '-e', SCRIPT], cwd=ROOT, text=True, capture_output=True,
        input=json.dumps({'decId': 'dec-a1', 'letter': letter, 'cardSha256': 'a' * 64}),
        check=False,
    )
    assert result.returncode == 0, result.stderr


@st.composite
def fingerprint_schedules(draw):
    count = draw(st.integers(min_value=2, max_value=5))
    return (draw(st.permutations(range(count))),
            draw(st.lists(st.booleans(), min_size=count, max_size=count)))


@settings(max_examples=100, deadline=None, database=None, derandomize=True)
@example(schedule=([0, 1], [True, False]))
@given(schedule=fingerprint_schedules())
def only_current_fingerprint_changes_submission(schedule):
    script = """
const { checkSchedule } = require('./extensions/gascity/test/fingerprint-race.test.js')
const [order, successes] = JSON.parse(require('node:fs').readFileSync(0, 'utf8'))
checkSchedule(order, successes).catch((error) => { console.error(error); process.exitCode = 1 })
"""
    result = subprocess.run(
        [NODE, '-e', script], cwd=ROOT, text=True, capture_output=True,
        input=json.dumps(schedule), check=False,
    )
    assert result.returncode == 0, result.stderr


@settings(max_examples=100, deadline=None, database=None, derandomize=True)
@example(success=False, finish_first=False, retryable=False)
@given(success=st.booleans(), finish_first=st.booleans(), retryable=st.booleans())
def rerender_fingerprints_cannot_replace_submission(success, finish_first, retryable):
    script = '''
const { checkRerender } = require('./extensions/gascity/test/fingerprint-race.test.js')
const [success, finishFirst, retryable] = JSON.parse(require('node:fs').readFileSync(0, 'utf8'))
checkRerender(success, finishFirst, retryable ? { exitCode: 2, notSent: true, line: 'No answer was sent: unapproved' } : undefined).catch((error) => { console.error(error); process.exitCode = 1 })
'''
    result = subprocess.run(
        [NODE, '-e', script], cwd=ROOT, text=True, capture_output=True,
        input=json.dumps([success, finish_first, retryable]), check=False,
    )
    assert result.returncode == 0, result.stderr


@settings(max_examples=100, deadline=None, database=None, derandomize=True)
@example(results=[{'unknown': True, 'exitCode': 2, 'notSent': False}])
@given(results=st.lists(st.fixed_dictionaries({
    'unknown': st.booleans(), 'exitCode': st.integers(min_value=-1, max_value=3),
    'notSent': st.booleans(),
}), min_size=1, max_size=8))
def card_alias_tracks_submission(results):
    script = '''
const fs = require('node:fs')
const assert = require('node:assert/strict')
const window = {}
require('node:vm').runInNewContext(fs.readFileSync('extensions/gascity/answer-state.js', 'utf8'), { window })
const state = window.answerState
const key = state.keyOf('w1', 'dec-a', 'a'.repeat(64))
const heard = [], direct = []
state.subscribe('card', (entry) => (heard.push(entry.phase), true))
state.subscribe(key, (entry) => (direct.push(entry.phase), true))
for (const result of JSON.parse(fs.readFileSync(0, 'utf8'))) {
  state.begin(key, 'card')
  assert.equal(state.get('card'), state.get(key))
  state.finish(key, result, 100)
  assert.equal(state.get('card'), state.get(key))
  state.reconcile('w1', { listedKeys: new Set([key]), openKeys: new Set([key]), readStartedAt: 200, complete: true })
  assert.equal(state.get('card'), state.get(key))
  assert.deepEqual(heard, direct)
}
'''
    result = subprocess.run(
        [NODE, '-e', script], cwd=ROOT, text=True, capture_output=True,
        input=json.dumps(results), check=False,
    )
    assert result.returncode == 0, result.stderr


if __name__ == '__main__':
    invalid_letters_are_retryable_without_dispatch()
    only_current_fingerprint_changes_submission()
    rerender_fingerprints_cannot_replace_submission()
    card_alias_tracks_submission()
    print('answer properties: 4 passed (100 + 100 + 8 + 100 generated cases; 4 explicit regressions)')
