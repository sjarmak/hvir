import { describe, expect, it } from 'vitest'

import {
  fitGitGraphLaneMetrics,
  gitGraphWidth,
  RAIL_GRAPH_LANE_METRICS,
} from '../src/renderer/src/git/git-graph-lane-metrics'

describe('Git graph lane fitting', () => {
  it('keeps the natural lane width when the graph already fits', () => {
    expect(fitGitGraphLaneMetrics(3, RAIL_GRAPH_LANE_METRICS, 96)).toBe(
      RAIL_GRAPH_LANE_METRICS,
    )
  })

  it('compresses lanes so a wide graph never exceeds the cap', () => {
    for (const laneCount of [8, 20, 400]) {
      const metrics = fitGitGraphLaneMetrics(laneCount, RAIL_GRAPH_LANE_METRICS, 96)
      expect(gitGraphWidth(laneCount, metrics)).toBeCloseTo(96)
      expect(metrics.padding).toBe(RAIL_GRAPH_LANE_METRICS.padding)
    }
  })
})
