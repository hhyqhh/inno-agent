export const WINDOW_RESIZE_EDGES = ["n", "s", "e", "w", "ne", "nw", "se", "sw"];

/** Resize in screen DIPs, anchoring the opposite edge even at size limits. */
export function getWindowResizeBounds(start, edge, delta, minimum, maximum) {
  const width = edge.includes("e") || edge.includes("w")
    ? Math.max(minimum[0], Math.min(maximum[0] || Infinity, start.width + (edge.includes("w") ? -delta.x : delta.x)))
    : start.width;
  const height = edge.includes("n") || edge.includes("s")
    ? Math.max(minimum[1], Math.min(maximum[1] || Infinity, start.height + (edge.includes("n") ? -delta.y : delta.y)))
    : start.height;
  return {
    x: edge.includes("w") ? start.x + start.width - width : start.x,
    y: edge.includes("n") ? start.y + start.height - height : start.y,
    width,
    height,
  };
}
