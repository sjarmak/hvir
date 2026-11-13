import json
import os
from pathlib import Path
import subprocess
import unittest

from hypothesis import example, given, settings, strategies as st

ROOT = Path(__file__).resolve().parents[2]
MODULE = (ROOT / 'dev' / 'approve-connectors.mjs').as_uri()
NAMES = st.text(alphabet='abcdefghijklmnopqrstuvwxyz', min_size=1, max_size=12)


def node(body, value):
    script = f"import * as api from {json.dumps(MODULE)};" + body
    result = subprocess.run(
        ['node', '--input-type=module', '-e', script],
        input=json.dumps(value), text=True, capture_output=True, check=True,
        env={k: v for k, v in os.environ.items() if k not in ('GC_CITY', 'GC_CITY_PATH')},
    )
    return json.loads(result.stdout)


def declaration(actions):
    return dict(id='hvir-answer', description='Answer', context='workspace',
                timeoutMs=120000, outputBytes=65536,
                environment=['GC_CITY', 'PATH'], actions=actions)


@settings(max_examples=100, database=None, deadline=None, derandomize=True)
@given(actions=st.lists(NAMES, min_size=1, max_size=4, unique=True), setup=st.booleans())
@example(actions=['a'], setup=False)
def test_normalization_retains_action_order_and_core_key_order(actions, setup):
    value = declaration(actions)
    if setup:
        value['setup'] = {'executable': 'answer'}
    result = node("""
        let input = '';
        for await (const chunk of process.stdin) input += chunk;
        const value = JSON.parse(input);
        console.log(JSON.stringify(api.normalizeDeclaration(value)));
    """, value)
    expected = (['setup'] if setup else []) + [
        'actions', 'id', 'description', 'context', 'timeoutMs', 'outputBytes', 'environment',
    ]
    assert list(result) == expected
    assert result == value


@settings(max_examples=100, database=None, deadline=None, derandomize=True)
@given(host=st.sampled_from(['local', 'work', 'offline']), actions=st.lists(
    NAMES, min_size=1, max_size=4, unique=True))
@example(host='local', actions=['a'])
def test_saved_action_authority_is_never_rewritten(host, actions):
    saved = dict(installationId='inst', connector='hvir-answer', host=host,
                 executable='/missing/answer', canonicalExecutable='/original/answer',
                 configuration={'args': [], 'env': {'GC_CITY': '/chosen'}},
                 declaration=declaration(actions))
    result = node("""
        let input = '';
        for await (const chunk of process.stdin) input += chunk;
        const saved = JSON.parse(input);
        const installations = [{ installationId: 'inst', packageId: 'hvir.gascity',
            connectors: [{ ...saved.declaration, actions: ['changed'], environment: [],
                setup: { executable: 'answer' } }] }];
        const empty = await api.planApprovals({ saved: [], installations,
            lookup: () => { throw new Error('No automatic action approval'); },
            remotes: { work: new Map() } });
        if (empty.approvals.length) throw new Error('Created action authority');
        const plan = await api.planApprovals({ saved: [saved], installations,
            lookup: () => { throw new Error('No automatic action approval'); },
            remotes: { work: new Map(), offline: { unreachable: 'offline' } } });
        console.log(JSON.stringify(plan));
    """, saved)
    assert result == dict(approvals=[saved], report=[], dropped=0)


if __name__ == '__main__':
    suite = unittest.TestSuite(map(unittest.FunctionTestCase, [
        test_normalization_retains_action_order_and_core_key_order,
        test_saved_action_authority_is_never_rewritten,
    ]))
    raise SystemExit(not unittest.TextTestRunner(verbosity=2).run(suite).wasSuccessful())
