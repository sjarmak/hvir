import { beforeEach, describe, expect, it, vi } from 'vitest'
import { resolveMaintainedArchitectureContext } from '../scripts/architecture-maintained-branch.mts'
import { fullCommit, git, requireAncestor } from '../scripts/architecture-inventory.mts'

// The resolver owns selection; the existing inventory/history tests own system-Git ancestry.
vi.mock('../scripts/architecture-inventory.mts', () => ({
  fullCommit: vi.fn(),
  git: vi.fn(),
  requireAncestor: vi.fn(),
}))
const root = '/fixture'
const baseline = '912cc42e1c41f431bc0d4c8a78cfaf0ca7c6c138'
const head = 'a'.repeat(40)
beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(git).mockReturnValue('feat/beads-panel')
  vi.mocked(fullCommit).mockReturnValue(head)
})

describe('maintained branch architecture authority', () => {
  it('pins the baseline independently of candidate HEAD', () => {
    expect(resolveMaintainedArchitectureContext(root, {})).toEqual({
      kind: 'ordinary',
      target: 'feat/beads-panel',
      epic: null,
      base: baseline,
      head,
      tested: head,
    })
    expect(git).toHaveBeenCalledWith(root, ['branch', '--show-current'])
    expect(fullCommit).toHaveBeenCalledWith(root, 'HEAD')
    expect(requireAncestor).toHaveBeenCalledWith(root, baseline, head)
  })

  it.each(['main', 'feat/beads-panel-other', 'agent/issue-123', ''])(
    'leaves branch %s under upstream authority',
    (branch) => {
      vi.mocked(git).mockReturnValue(branch)
      expect(resolveMaintainedArchitectureContext(root, {})).toBeNull()
      expect(requireAncestor).not.toHaveBeenCalled()
    },
  )

  it('never selects local authority in GitHub Actions', () => {
    expect(
      resolveMaintainedArchitectureContext(root, { GITHUB_ACTIONS: 'true' }),
    ).toBeNull()
    expect(git).not.toHaveBeenCalled()
  })

  it('ignores environment attempts to override branch or baseline', () => {
    expect(
      resolveMaintainedArchitectureContext(root, {
        HVIR_ARCHITECTURE_BASE: head,
        GITHUB_BASE_REF: 'main',
        GITHUB_SHA: head,
      })?.base,
    ).toBe(baseline)
    expect(requireAncestor).toHaveBeenCalledWith(root, baseline, head)
  })

  it('propagates failure to establish baseline ancestry', () => {
    const failure = new Error('Missing baseline or not an ancestor')
    vi.mocked(requireAncestor).mockImplementation(() => {
      throw failure
    })
    expect(() => resolveMaintainedArchitectureContext(root, {})).toThrow(failure)
  })
})
