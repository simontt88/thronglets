import { COLOR, type PixelGrid, setPx } from "../types";
import { ANCHORS } from "../species";
import type { MoodName } from "../types";

// 8 eye variants. Each draws BOTH eyes from a single function.
// Eye anchor is the top-left of the eye cell. Eyes are typically 4 wide x 3 tall.
// Pupil position can be offset for "looking" effect. Mood overrides for blink/closed/dead.

type EyeFn = (g: PixelGrid, mood: MoodName, frame: number) => void;

const L = ANCHORS.leftEye;
const R = ANCHORS.rightEye;

// 0 — Round (canonical Thronglet)
const eyeRound: EyeFn = (g, mood, frame) => {
  if (handleStandardMoods(g, mood, frame)) return;
  drawShape(g, L.x, L.y, [
    "WWWW",
    "WKKW",
    "WWWW",
  ]);
  drawShape(g, R.x, R.y, [
    "WWWW",
    "WKKW",
    "WWWW",
  ]);
};

// 1 — Round w/ glint (highlight pixel)
const eyeGlint: EyeFn = (g, mood, frame) => {
  if (handleStandardMoods(g, mood, frame)) return;
  drawShape(g, L.x, L.y, [
    "WWWW",
    "WKKW",
    "WWWW",
  ]);
  drawShape(g, R.x, R.y, [
    "WWWW",
    "WKKW",
    "WWWW",
  ]);
  setPx(g, L.x + 1, L.y, COLOR.BODY_LITE);
  setPx(g, R.x + 1, R.y, COLOR.BODY_LITE);
};

// 2 — Wide-open surprised
const eyeWide: EyeFn = (g, mood, frame) => {
  if (handleStandardMoods(g, mood, frame)) return;
  drawShape(g, L.x, L.y - 1, [
    "WWWW",
    "WKKW",
    "WKKW",
    "WWWW",
  ]);
  drawShape(g, R.x, R.y - 1, [
    "WWWW",
    "WKKW",
    "WKKW",
    "WWWW",
  ]);
};

// 3 — Sleepy half-lidded
const eyeSleepy: EyeFn = (g, mood, frame) => {
  if (handleStandardMoods(g, mood, frame)) return;
  drawShape(g, L.x, L.y, [
    "OOOO",
    "WKKW",
    "OOOO",
  ]);
  drawShape(g, R.x, R.y, [
    "OOOO",
    "WKKW",
    "OOOO",
  ]);
};

// 4 — Dots (tiny pupils, large white)
const eyeDot: EyeFn = (g, mood, frame) => {
  if (handleStandardMoods(g, mood, frame)) return;
  drawShape(g, L.x, L.y, [
    "WWWW",
    "WWKW",
    "WWWW",
  ]);
  drawShape(g, R.x, R.y, [
    "WWWW",
    "WKWW",
    "WWWW",
  ]);
};

// 5 — Star (excited / happy)
const eyeStar: EyeFn = (g, mood, frame) => {
  if (handleStandardMoods(g, mood, frame)) return;
  drawShape(g, L.x, L.y, [
    "AKKA",
    "KKKK",
    "AKKA",
  ]);
  drawShape(g, R.x, R.y, [
    "AKKA",
    "KKKK",
    "AKKA",
  ]);
};

// 6 — Wink (left closed, right open)
const eyeWink: EyeFn = (g, mood, frame) => {
  if (handleStandardMoods(g, mood, frame)) return;
  drawShape(g, L.x, L.y, [
    "....",
    "KKKK",
    "....",
  ]);
  drawShape(g, R.x, R.y, [
    "WWWW",
    "WKKW",
    "WWWW",
  ]);
};

// 7 — Line (calm / blank)
const eyeLine: EyeFn = (g, mood, frame) => {
  if (handleStandardMoods(g, mood, frame)) return;
  drawShape(g, L.x, L.y + 1, [
    "KKKK",
  ]);
  drawShape(g, R.x, R.y + 1, [
    "KKKK",
  ]);
};

// Handles blink, sleeping, dead — returns true if it drew something.
function handleStandardMoods(g: PixelGrid, mood: MoodName, frame: number): boolean {
  if (mood === "dead") {
    drawShape(g, L.x, L.y, [
      "K..K",
      ".KK.",
      "K..K",
    ]);
    drawShape(g, R.x, R.y, [
      "K..K",
      ".KK.",
      "K..K",
    ]);
    return true;
  }
  if (mood === "sleeping") {
    drawShape(g, L.x, L.y, [
      "....",
      "KKKK",
      "....",
    ]);
    drawShape(g, R.x, R.y, [
      "....",
      "KKKK",
      "....",
    ]);
    return true;
  }
  // Auto-blink every ~40 frames for 2 frames
  if ((frame % 40) < 2 && mood !== "happy") {
    drawShape(g, L.x, L.y, [
      "....",
      "KKKK",
      "....",
    ]);
    drawShape(g, R.x, R.y, [
      "....",
      "KKKK",
      "....",
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
      if (ch === "W") setPx(g, x0 + dx, y0 + dy, COLOR.EYE_WHITE);
      else if (ch === "K") setPx(g, x0 + dx, y0 + dy, COLOR.PUPIL);
      else if (ch === "O") setPx(g, x0 + dx, y0 + dy, COLOR.OUTLINE);
      else if (ch === "A") setPx(g, x0 + dx, y0 + dy, COLOR.ACCENT);
    }
  }
}

export const EYES: EyeFn[] = [eyeRound, eyeGlint, eyeWide, eyeSleepy, eyeDot, eyeStar, eyeWink, eyeLine];
