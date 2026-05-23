export interface PackItem {
  id: string;
  colSpan: number;
  height: number;
}

export interface Placement {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function packItems(
  items: PackItem[],
  containerWidth: number,
  cols: number,
  gap: number,
): { placements: Record<string, Placement>; totalH: number; colW: number } {
  const colW = (containerWidth - gap * (cols - 1)) / cols;
  const heights = new Array(cols).fill(0);
  const placements: Record<string, Placement> = {};

  for (const it of items) {
    const span = Math.max(1, Math.min(it.colSpan || 1, cols));
    let bestCol = 0;
    let bestY = Infinity;
    for (let i = 0; i <= cols - span; i++) {
      const y = Math.max(...heights.slice(i, i + span));
      if (y < bestY) { bestY = y; bestCol = i; }
    }
    const x = bestCol * (colW + gap);
    const w = colW * span + gap * (span - 1);
    const h = it.height || 320;
    placements[it.id] = { x, y: bestY, w, h };
    for (let i = bestCol; i < bestCol + span; i++) heights[i] = bestY + h + gap;
  }

  const totalH = Math.max(0, ...heights) - gap;
  return { placements, totalH, colW };
}
