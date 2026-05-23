import { COLOR, type ColorKey, type PixelGrid, setPx } from "../types";
import { ANCHORS } from "../species";

type HornFn = (g: PixelGrid) => void;

const A = ANCHORS.horn; // (11, 2) — center column of head top

// 0 — single antenna with square tip (matches reference)
const hornAntenna: HornFn = (g) => {
  drawCol(g, A.x, 0, 3, COLOR.OUTLINE);
  setPx(g, A.x - 1, 0, COLOR.OUTLINE);
  setPx(g, A.x + 1, 0, COLOR.OUTLINE);
  setPx(g, A.x, 0, COLOR.ACCENT);
};

// 1 — fluffy tuft (3-cell hair sprig)
const hornTuft: HornFn = (g) => {
  drawShape(g, A.x - 1, 0, [
    "OEO",
    "OEEO",
    "OOOO",
  ]);
};

// 2 — twin antennae
const hornTwin: HornFn = (g) => {
  drawCol(g, A.x - 2, 0, 3, COLOR.OUTLINE);
  drawCol(g, A.x + 2, 0, 3, COLOR.OUTLINE);
  setPx(g, A.x - 2, 0, COLOR.ACCENT);
  setPx(g, A.x + 2, 0, COLOR.ACCENT);
};

// 3 — sprout / leaf
const hornSprout: HornFn = (g) => {
  drawShape(g, A.x - 1, 0, [
    ".A.",
    "AEA",
    "OEO",
    "OOOO",
  ]);
};

// 4 — single spike
const hornSpike: HornFn = (g) => {
  drawShape(g, A.x, 0, [
    "O",
    "O",
    "OO",
  ]);
};

// 5 — none / bare
const hornNone: HornFn = (_g) => {
  // intentionally empty
};

function drawCol(g: PixelGrid, x: number, y0: number, height: number, color: ColorKey): void {
  for (let dy = 0; dy < height; dy++) setPx(g, x, y0 + dy, color);
}

function drawShape(g: PixelGrid, x0: number, y0: number, rows: string[]): void {
  for (let dy = 0; dy < rows.length; dy++) {
    const row = rows[dy];
    for (let dx = 0; dx < row.length; dx++) {
      const ch = row.charAt(dx);
      if (ch === "O") setPx(g, x0 + dx, y0 + dy, COLOR.OUTLINE);
      else if (ch === "E") setPx(g, x0 + dx, y0 + dy, COLOR.EARS);
      else if (ch === "A") setPx(g, x0 + dx, y0 + dy, COLOR.ACCENT);
    }
  }
}

export const HORNS: HornFn[] = [hornAntenna, hornTuft, hornTwin, hornSprout, hornSpike, hornNone];
