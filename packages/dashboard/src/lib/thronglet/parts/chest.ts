import { COLOR, type ColorKey, type PixelGrid, getPx, setPx } from "../types";
import { ANCHORS } from "../species";

type ChestFn = (g: PixelGrid) => void;

// Only draw on body pixels (don't overwrite outline / transparent).
function paintBody(g: PixelGrid, x: number, y: number, c: ColorKey): void {
  const cur = getPx(g, x, y);
  if (cur === COLOR.BODY || cur === COLOR.BODY_SHADE || cur === COLOR.BODY_LITE) {
    setPx(g, x, y, c);
  }
}

const A = ANCHORS.chest; // { x: 4, y: 17, w: 16, h: 3 }

// 0 — full sash band (matches reference)
const chestSash: ChestFn = (g) => {
  for (let dx = 0; dx < A.w; dx++) {
    paintBody(g, A.x + dx, A.y,     COLOR.SASH_SHADE);
    paintBody(g, A.x + dx, A.y + 1, COLOR.SASH);
    paintBody(g, A.x + dx, A.y + 2, COLOR.SASH_SHADE);
  }
};

// 1 — striped band (3 stripes)
const chestStripes: ChestFn = (g) => {
  for (let dx = 0; dx < A.w; dx++) {
    const stripe = Math.floor(dx / 2) % 2 === 0;
    if (stripe) {
      paintBody(g, A.x + dx, A.y,     COLOR.SASH_SHADE);
      paintBody(g, A.x + dx, A.y + 1, COLOR.SASH);
      paintBody(g, A.x + dx, A.y + 2, COLOR.SASH_SHADE);
    }
  }
};

// 2 — bowtie (centered, narrower)
const chestBow: ChestFn = (g) => {
  const cx = A.x + Math.floor(A.w / 2) - 2;
  paintBody(g, cx,     A.y,     COLOR.SASH);
  paintBody(g, cx + 3, A.y,     COLOR.SASH);
  paintBody(g, cx,     A.y + 1, COLOR.SASH);
  paintBody(g, cx + 1, A.y + 1, COLOR.SASH_SHADE);
  paintBody(g, cx + 2, A.y + 1, COLOR.SASH_SHADE);
  paintBody(g, cx + 3, A.y + 1, COLOR.SASH);
  paintBody(g, cx,     A.y + 2, COLOR.SASH);
  paintBody(g, cx + 3, A.y + 2, COLOR.SASH);
};

// 3 — pocket (small square)
const chestPocket: ChestFn = (g) => {
  const cx = A.x + Math.floor(A.w / 2) - 1;
  paintBody(g, cx,     A.y,     COLOR.SASH);
  paintBody(g, cx + 1, A.y,     COLOR.SASH);
  paintBody(g, cx,     A.y + 1, COLOR.SASH_SHADE);
  paintBody(g, cx + 1, A.y + 1, COLOR.SASH_SHADE);
};

// 4 — collar (top edge only)
const chestCollar: ChestFn = (g) => {
  for (let dx = 1; dx < A.w - 1; dx++) {
    paintBody(g, A.x + dx, A.y, COLOR.SASH);
  }
  paintBody(g, A.x + 2,         A.y + 1, COLOR.SASH_SHADE);
  paintBody(g, A.x + A.w - 3,   A.y + 1, COLOR.SASH_SHADE);
};

// 5 — bare (no chest decoration)
const chestBare: ChestFn = (_g) => {
  // intentionally empty
};

export const CHEST: ChestFn[] = [chestSash, chestStripes, chestBow, chestPocket, chestCollar, chestBare];
