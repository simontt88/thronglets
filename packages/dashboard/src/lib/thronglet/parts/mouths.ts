import { COLOR, type PixelGrid, setPx } from "../types";
import { ANCHORS } from "../species";
import type { MoodName } from "../types";

type MouthFn = (g: PixelGrid, mood: MoodName, frame: number) => void;

const A = ANCHORS.mouth; // (12, 13) — drawn around this point

// 0 — small smile
const mouthSmile: MouthFn = (g, mood, frame) => {
  if (overrideMood(g, mood, frame)) return;
  drawShape(g, A.x - 1, A.y, [
    "M..M",
    ".MM.",
  ]);
};

// 1 — open (talking)
const mouthOpen: MouthFn = (g, mood, frame) => {
  if (overrideMood(g, mood, frame)) return;
  const open = (frame % 16) < 8;
  if (open) {
    drawShape(g, A.x - 1, A.y, [
      ".MM.",
      "MppM",
      ".MM.",
    ]);
  } else {
    drawShape(g, A.x - 1, A.y, [
      "MMMM",
      "....",
    ]);
  }
};

// 2 — small "o"
const mouthO: MouthFn = (g, mood, frame) => {
  if (overrideMood(g, mood, frame)) return;
  drawShape(g, A.x - 1, A.y, [
    ".MM.",
    "MppM",
    ".MM.",
  ]);
};

// 3 — flat line
const mouthFlat: MouthFn = (g, mood, frame) => {
  if (overrideMood(g, mood, frame)) return;
  drawShape(g, A.x - 1, A.y + 1, [
    "MMMM",
  ]);
};

// 4 — open laugh (wide)
const mouthLaugh: MouthFn = (g, mood, frame) => {
  if (overrideMood(g, mood, frame)) return;
  drawShape(g, A.x - 2, A.y, [
    "MMMMMM",
    "MpppPM",
    ".MMMM.",
  ]);
};

// 5 — fang (single tooth)
const mouthFang: MouthFn = (g, mood, frame) => {
  if (overrideMood(g, mood, frame)) return;
  drawShape(g, A.x - 1, A.y, [
    "M..M",
    ".MM.",
  ]);
  setPx(g, A.x, A.y + 1, COLOR.EYE_WHITE);  // tiny fang
};

function overrideMood(g: PixelGrid, mood: MoodName, _frame: number): boolean {
  if (mood === "skeptical") {
    drawShape(g, A.x - 1, A.y + 1, [
      ".MM.",
      "M..M",
    ]);
    return true;
  }
  if (mood === "dead") {
    drawShape(g, A.x - 1, A.y + 1, [
      "MMMM",
    ]);
    return true;
  }
  if (mood === "sleeping") {
    drawShape(g, A.x - 1, A.y, [
      "..MM",
      ".MM.",
    ]);
    return true;
  }
  return false;
}

function drawShape(g: PixelGrid, x0: number, y0: number, rows: string[]): void {
  for (let dy = 0; dy < rows.length; dy++) {
    const row = rows[dy];
    for (let dx = 0; dx < row.length; dx++) {
      const ch = row.charAt(dx);
      if (ch === "M") setPx(g, x0 + dx, y0 + dy, COLOR.MOUTH);
      else if (ch === "p") setPx(g, x0 + dx, y0 + dy, COLOR.PUPIL);
      else if (ch === "P") setPx(g, x0 + dx, y0 + dy, COLOR.MOUTH);
    }
  }
}

export const MOUTHS: MouthFn[] = [mouthSmile, mouthOpen, mouthO, mouthFlat, mouthLaugh, mouthFang];
