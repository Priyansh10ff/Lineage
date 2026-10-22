import type { GraphLane } from '@lineage/core';

/**
 * Line colors. The primary line is always blue; others cycle. Neighbours differ in lightness
 * too, and text never sits on these colors except the blue, so contrast holds.
 */
const PALETTE = ['#1F4FD1', '#F08A24', '#0F7A5C', '#8A5CC9', '#C2416B', '#2B8FB3', '#9C7A1E'];

export function laneColor(lane: Pick<GraphLane, 'index'>): string {
  return PALETTE[lane.index % PALETTE.length]!;
}

/** Agent branches are drawn dotted so a human can tell them apart without relying on color. */
export function isAgentBranch(name: string): boolean {
  return name.startsWith('agent/');
}
