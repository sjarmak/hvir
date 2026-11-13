import json
import subprocess
from pathlib import Path

from hypothesis import example, given, settings, strategies as st

ROOT = Path(__file__).resolve().parents[3]
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
        ['node', '-e', SCRIPT], cwd=ROOT, text=True, capture_output=True,
        input=json.dumps({'decId': 'dec-a1', 'letter': letter, 'cardSha256': 'a' * 64}),
        check=False,
    )
    assert result.returncode == 0, result.stderr


if __name__ == '__main__':
    invalid_letters_are_retryable_without_dispatch()
    print('answer properties: 1 passed (100 generated cases and 1 explicit regression)')
