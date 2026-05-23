import { COLOR, GRID, type ColorKey, type PixelGrid, emptyGrid, setPx, getPx } from "./types";

// Base silhouette traced to match the perler-bead reference Thronglet.
// 24x24 grid. Each row must be exactly 24 chars.
//   '.'  transparent
//   'b'  body
//   'O'  outline
//   'L'  body highlight (top of head)
//   'S'  body shade (under-belly / cheeks)

const SILHOUETTE: string[] = [
  "........................", //  0
  "........................", //  1
  "........................", //  2  horn parts may draw here
  ".....OOOOO..OOOOO.......", //  3
  "....ObbbbbOObbbbbO......", //  4
  "....ObbbbbbbbbbbbO......", //  5
  "...ObLLLbbbbbbbLLLbO....", //  6
  "..ObLLLbbbbbbbbbbLLLbO..", //  7
  "..ObbbbbbbbbbbbbbbbbbO..", //  8
  "..ObbbbbbbbbbbbbbbbbbO..", //  9  eye row top
  "..ObbbbbbbbbbbbbbbbbbO..", // 10  eye row mid
  "..ObbbbbbbbbbbbbbbbbbO..", // 11  eye row bot
  "..ObbSSbbbbbbbbbbSSbbO..", // 12  cheeks
  "..ObbSSbbbbbbbbbbSSbbO..", // 13  mouth row
  "..ObbbbbbbbbbbbbbbbbbO..", // 14
  "...ObbbbbbbbbbbbbbbbO...", // 15
  "....ObbbbbbbbbbbbbbO....", // 16
  "....ObbbbbbbbbbbbbbO....", // 17  chest band area
  "....ObbbbbbbbbbbbbbO....", // 18  chest band area
  "....ObbbbbbbbbbbbbbO....", // 19  chest band area
  ".....OObbbbbbbbbbOO.....", // 20
  ".....ObbO......ObbO.....", // 21  feet
  ".....ObbO......ObbO.....", // 22  feet
  ".....OOOO......OOOO.....", // 23  feet base
];

function charToColor(ch: string): ColorKey | null {
  switch (ch) {
    case "b": return COLOR.BODY;
    case "L": return COLOR.BODY_LITE;
    case "S": return COLOR.BODY_SHADE;
    case "O": return COLOR.OUTLINE;
    default: return null;
  }
}

export interface Anchors {
  leftEar:   { x: number; y: number };  // top-left of ear cell
  rightEar:  { x: number; y: number };
  leftEye:   { x: number; y: number };  // top-left of eye cell (eyes are 4x3)
  rightEye:  { x: number; y: number };
  mouth:     { x: number; y: number };  // center of mouth (mouths drawn around this)
  horn:      { x: number; y: number };  // top-center of head (horn extends upward)
  chest:     { x: number; y: number; w: number; h: number };
}

export const ANCHORS: Anchors = {
  leftEar:   { x: 3,  y: 3 },
  rightEar:  { x: 16, y: 3 },
  leftEye:   { x: 6,  y: 9 },
  rightEye:  { x: 13, y: 9 },
  mouth:     { x: 12, y: 14 },
  horn:      { x: 11, y: 2 },
  chest:     { x: 5, y: 17, w: 14, h: 3 },
};

export function drawSilhouette(g: PixelGrid): void {
  for (let y = 0; y < GRID; y++) {
    const row = SILHOUETTE[y] || "";
    for (let x = 0; x < GRID; x++) {
      const ch = row.charAt(x) || ".";
      const c = charToColor(ch);
      if (c !== null) setPx(g, x, y, c);
    }
  }
}

export function bodyMask(): PixelGrid {
  const g = emptyGrid();
  drawSilhouette(g);
  return g;
}

// Returns true if the cell is body (any of body / shade / lite / outline).
export function isBody(g: PixelGrid, x: number, y: number): boolean {
  const c = getPx(g, x, y);
  return c === COLOR.BODY || c === COLOR.BODY_SHADE || c === COLOR.BODY_LITE || c === COLOR.OUTLINE;
}
