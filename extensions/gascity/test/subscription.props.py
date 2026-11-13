import json
import shutil
import subprocess
from pathlib import Path

from hypothesis import example, given, settings, strategies as st

ROOT = Path(__file__).resolve().parents[3]
NODE = shutil.which('node')
SCRIPT = """
const { checkRouting } = require('./extensions/gascity/test/subscription.test.js')
const [order, successes] = JSON.parse(require('node:fs').readFileSync(0, 'utf8'))
Promise.all(['host.js', 'pr/host.js', '../pulls/host.js'].map((file) => checkRouting(file, order, successes)))
  .catch((error) => { console.error(error); process.exitCode = 1 })
"""


@st.composite
def replies(draw):
    count = draw(st.integers(min_value=4, max_value=12))
    return (draw(st.permutations(range(count))),
            draw(st.lists(st.booleans(), min_size=count, max_size=count)))


@settings(max_examples=100, deadline=None, database=None, derandomize=True)
@example(schedule=([0, 1, 2, 3], [True, True, True, True]))
@given(schedule=replies())
def replies_settle_only_the_matching_request(schedule):
    result = subprocess.run(
        [NODE, '-e', SCRIPT], cwd=ROOT, text=True, capture_output=True,
        input=json.dumps(schedule), check=False,
    )
    assert result.returncode == 0, result.stderr


REFUSALS = [
    'Extension subscription limit exceeded',
    'Close an extension view before opening another',
    'This view is opening or stopped',
    'Extension view was revoked',
    'Extension view was disposed',
]


@settings(max_examples=100, deadline=None, database=None, derandomize=True)
@example(kind=None, detail='private-id-987')
@example(kind=0, detail='private-id-987')
@given(kind=st.one_of(st.none(), st.integers(min_value=0, max_value=4)), detail=st.text())
def card_refusals_never_echo_unrelated_details(kind, detail):
    script = """
const { checkRefusal } = require('./extensions/gascity/test/subscription.test.js')
const [message, expected] = JSON.parse(require('node:fs').readFileSync(0, 'utf8'))
const cleanup = []
checkRefusal({ after: (fn) => cleanup.push(fn) }, message, expected)
  .catch((error) => { console.error(error); process.exitCode = 1 })
  .finally(() => cleanup.forEach((fn) => fn()))
"""
    expected = REFUSALS[kind] if kind is not None else 'hvir refused to open this page'
    message = f'{REFUSALS[kind] if kind is not None else "Unknown refusal"}: {detail}'
    result = subprocess.run(
        [NODE, '-e', script], cwd=ROOT, text=True, capture_output=True,
        input=json.dumps([message, expected]), check=False,
    )
    assert result.returncode == 0, result.stderr


if __name__ == '__main__':
    replies_settle_only_the_matching_request()
    card_refusals_never_echo_unrelated_details()
    print('subscription properties: 2 passed (200 generated cases; 3 explicit regressions; routing across all three clients)')
