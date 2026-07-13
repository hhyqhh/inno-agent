import type { NodeApi } from "react-arborist";
import type { ArboristNode } from "../types/workspace.js";

export type LineType = "full" | "half" | "corner" | "none";

export interface LineConfig {
  type: LineType;
  /** For "corner" type: whether to draw the vertical continuation below the corner. */
  showContinuation: boolean;
}

/**
 * Compute which type of tree-line stroke to render for every indent column.
 *
 * Rules:
 * - Each indent column maps to one entry in the returned array (length = node.level).
 * - The *last* entry is always a "corner" (L-shaped connector with rounded curve).
 * - Earlier entries are "full" (trunk line through the whole row height) or
 *   "none" (no line — used when the ancestor at that depth is the last child
 *   of *its* parent, so no further siblings follow).
 * - The corner's `showContinuation` is true only when the current node is *not*
 *   the last child — i.e. the vertical trunk should continue below this row.
 */
export function getLineConfigs(node: NodeApi<ArboristNode>): LineConfig[] {
  const level = node.level;
  if (level === 0) return [];

  // Determine whether the node at each depth is the last child of its parent.
  const lastChildAtLevel = new Map<number, boolean>();

  // Current node
  if (node.parent?.children?.length) {
    const sibs = node.parent.children;
    lastChildAtLevel.set(level, node.id === sibs[sibs.length - 1].id);
  }

  // Walk up the ancestors
  let cursor: NodeApi<ArboristNode> | null = node.parent;
  while (cursor) {
    if (cursor.parent?.children?.length) {
      const sibs = cursor.parent.children;
      lastChildAtLevel.set(cursor.level, cursor.id === sibs[sibs.length - 1].id);
    }
    cursor = cursor.parent;
  }

  const configs: LineConfig[] = [];
  for (let i = 0; i < level; i++) {
    if (i === level - 1) {
      // Direct parent → rounded L-corner
      const isCurrentLast = lastChildAtLevel.get(level) ?? true;
      configs.push({ type: "corner", showContinuation: !isCurrentLast });
    } else {
      // Ancestor trunk — full line unless the next-level ancestor is the last child
      const isNextLast = lastChildAtLevel.get(i + 1) ?? false;
      configs.push({ type: isNextLast ? "none" : "full", showContinuation: false });
    }
  }

  return configs;
}