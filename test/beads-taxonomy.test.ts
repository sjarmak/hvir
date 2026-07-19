import { describe, expect, it } from 'vitest'

import { classifyIssueType, isExecutableLeaf } from '../src/shared'

describe('classifyIssueType', () => {
  it('maps bd issue types to human categories', () => {
    expect(classifyIssueType('feature')).toBe('executable-leaf')
    expect(classifyIssueType('bug')).toBe('executable-leaf')
    expect(classifyIssueType('task')).toBe('executable-leaf')
    expect(classifyIssueType('chore')).toBe('executable-leaf')
    expect(classifyIssueType('epic')).toBe('outcome')
    expect(classifyIssueType('decision')).toBe('outcome')
    expect(classifyIssueType('convoy')).toBe('orchestration')
    expect(classifyIssueType('molecule')).toBe('orchestration')
    expect(classifyIssueType('gate')).toBe('gate')
    expect(classifyIssueType('merge-request')).toBe('ship')
    expect(classifyIssueType('agent')).toBe('infra')
    expect(classifyIssueType('rig')).toBe('infra')
  })

  it('normalises aliases and casing', () => {
    expect(classifyIssueType('MR')).toBe('ship')
    expect(classifyIssueType('feat')).toBe('executable-leaf')
    expect(classifyIssueType('mol')).toBe('orchestration')
    expect(classifyIssueType('adr')).toBe('outcome')
    expect(classifyIssueType('  Epic ')).toBe('outcome')
  })

  it('leaves unrecognised types visible as unknown', () => {
    expect(classifyIssueType('wibble')).toBe('unknown')
    expect(classifyIssueType('')).toBe('unknown')
  })
})

describe('isExecutableLeaf', () => {
  it('is true only for real leaf work', () => {
    expect(isExecutableLeaf('task')).toBe(true)
    expect(isExecutableLeaf('bug')).toBe(true)
    expect(isExecutableLeaf('epic')).toBe(false)
    expect(isExecutableLeaf('convoy')).toBe(false)
    expect(isExecutableLeaf('gate')).toBe(false)
    expect(isExecutableLeaf('merge-request')).toBe(false)
    expect(isExecutableLeaf('wibble')).toBe(false)
  })
})
