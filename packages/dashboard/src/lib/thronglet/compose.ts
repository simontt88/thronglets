import { COLOR, GRID, emptyGrid, setPx, type PixelGrid, type MoodName, type ThrongletSpec } from "./types";
import { drawSilhouette, ANCHORS } from "./species";
import { EARS } from "./parts/ears";
import { EYES } from "./parts/eyes";
import { MOUTHS } from "./parts/mouths";
import { HORNS } from "./parts/horns";
import { CHEST } from "./parts/chest";

export function composeGrid(spec: ThrongletSpec, mood: MoodName, frame: number): PixelGrid {
  const g = emptyGrid();

  HORNS[spec.horn % HORNS.length](g);
  drawSilhouette(g);
  EARS[spec.ears % EARS.length](g);
  CHEST[spec.chest % CHEST.length](g);

  // Force open-close mouth cycle in talking mood (overrides any mouth variant)
  EYES[spec.eyes % EYES.length](g, mood, frame);
  if (mood === "talking") {
    drawTalkingMouth(g, frame);
  } else {
    MOUTHS[spec.mouth % MOUTHS.length](g, mood, frame);
  }

  // Mood-specific overlay effects (sparkles, speech bubbles, etc.)
  applyEffectLayer(g, mood, frame);

  return g;
}

function drawTalkingMouth(g: PixelGrid, frame: number): void {
  const A = ANCHORS.mouth;
  const phase = Math.floor(frame / 3) % 4;
  if (phase === 0) {
    // closed
    setPx(g, A.x - 1, A.y + 1, COLOR.MOUTH);
    setPx(g, A.x,     A.y + 1, COLOR.MOUTH);
    setPx(g, A.x + 1, A.y + 1, COLOR.MOUTH);
  } else if (phase === 1) {
    // tiny open
    setPx(g, A.x - 1, A.y,     COLOR.MOUTH);
    setPx(g, A.x,     A.y,     COLOR.PUPIL);
    setPx(g, A.x + 1, A.y,     COLOR.MOUTH);
    setPx(g, A.x - 1, A.y + 1, COLOR.MOUTH);
    setPx(g, A.x,     A.y + 1, COLOR.MOUTH);
    setPx(g, A.x + 1, A.y + 1, COLOR.MOUTH);
  } else if (phase === 2) {
    // wide open
    setPx(g, A.x - 1, A.y,     COLOR.MOUTH);
    setPx(g, A.x,     A.y,     COLOR.PUPIL);
    setPx(g, A.x + 1, A.y,     COLOR.MOUTH);
    setPx(g, A.x - 1, A.y + 1, COLOR.MOUTH);
    setPx(g, A.x,     A.y + 1, COLOR.PUPIL);
    setPx(g, A.x + 1, A.y + 1, COLOR.MOUTH);
    setPx(g, A.x - 1, A.y + 2, COLOR.MOUTH);
    setPx(g, A.x,     A.y + 2, COLOR.MOUTH);
    setPx(g, A.x + 1, A.y + 2, COLOR.MOUTH);
  } else {
    // back to closed
    setPx(g, A.x - 1, A.y + 1, COLOR.MOUTH);
    setPx(g, A.x,     A.y + 1, COLOR.MOUTH);
    setPx(g, A.x + 1, A.y + 1, COLOR.MOUTH);
  }
}

function applyEffectLayer(g: PixelGrid, mood: MoodName, frame: number): void {
  if (mood === "working") {
    // Animated cog pixels (2x2) on each side of the head — visually unmistakable
    const slow = Math.floor(frame / 3) % 4;
    drawSparkle(g, 0, 5, slow);
    drawSparkle(g, 22, 5, (slow + 2) % 4);
    drawSparkle(g, 0, 10, (slow + 1) % 4);
    drawSparkle(g, 22, 10, (slow + 3) % 4);
  }

  if (mood === "talking") {
    // Speech bubble dots that rise one-by-one then reset (clear chain)
    const cycle = 10;
    const phase = Math.floor(frame / 2) % cycle;
    if (phase >= 0 && phase < 7) setPx(g, 21, 8,  COLOR.PUPIL);
    if (phase >= 2 && phase < 7) setPx(g, 22, 6,  COLOR.PUPIL);
    if (phase >= 4 && phase < 7) setPx(g, 23, 4,  COLOR.PUPIL);
  }

  if (mood === "happy") {
    // Star sparkles around the head + tiny twinkle pixels
    const phase = Math.floor(frame / 3) % 4;
    if (phase === 0 || phase === 2) {
      drawStar(g, 1,  4);
      drawStar(g, 22, 4);
    }
    if (phase === 1 || phase === 3) {
      drawStar(g, 2,  7);
      drawStar(g, 21, 7);
    }
  }

  if (mood === "skeptical") {
    // Sweat drop on the right
    if (Math.floor(frame / 4) % 3 < 2) {
      setPx(g, 19, 6, COLOR.SASH);
      setPx(g, 20, 7, COLOR.SASH);
      setPx(g, 19, 7, COLOR.SASH);
      setPx(g, 19, 8, COLOR.SASH);
    }
  }

  if (mood === "sleeping") {
    // 'Z' shape floating up
    const phase = Math.floor(frame / 4) % 5;
    const dx = 16 + phase;
    const dy = 5 - phase;
    if (dy >= 0 && dy < 6) {
      setPx(g, dx,     dy,     COLOR.OUTLINE);
      setPx(g, dx + 1, dy,     COLOR.OUTLINE);
      setPx(g, dx + 2, dy,     COLOR.OUTLINE);
      setPx(g, dx + 1, dy + 1, COLOR.OUTLINE);
      setPx(g, dx,     dy + 2, COLOR.OUTLINE);
      setPx(g, dx + 1, dy + 2, COLOR.OUTLINE);
      setPx(g, dx + 2, dy + 2, COLOR.OUTLINE);
    }
  }

  if (mood === "dead") {
    // Halo above the head
    for (let x = 9; x <= 14; x++) setPx(g, x, 0, COLOR.ACCENT);
    setPx(g, 8,  1, COLOR.ACCENT);
    setPx(g, 15, 1, COLOR.ACCENT);
  }
}

function drawSparkle(g: PixelGrid, x: number, y: number, phase: number): void {
  if (phase === 0) {
    setPx(g, x + 1, y,     COLOR.ACCENT);
    setPx(g, x,     y + 1, COLOR.ACCENT);
    setPx(g, x + 2, y + 1, COLOR.ACCENT);
    setPx(g, x + 1, y + 2, COLOR.ACCENT);
  } else if (phase === 1) {
    setPx(g, x,     y,     COLOR.ACCENT);
    setPx(g, x + 2, y,     COLOR.ACCENT);
    setPx(g, x + 1, y + 1, COLOR.ACCENT);
    setPx(g, x,     y + 2, COLOR.ACCENT);
    setPx(g, x + 2, y + 2, COLOR.ACCENT);
  } else if (phase === 2) {
    setPx(g, x + 1, y + 1, COLOR.ACCENT);
  }
  // phase 3 = invisible (gap)
}

function drawStar(g: PixelGrid, x: number, y: number): void {
  setPx(g, x + 1, y,     COLOR.ACCENT);
  setPx(g, x,     y + 1, COLOR.ACCENT);
  setPx(g, x + 1, y + 1, COLOR.ACCENT);
  setPx(g, x + 2, y + 1, COLOR.ACCENT);
  setPx(g, x + 1, y + 2, COLOR.ACCENT);
}

export const GRID_SIZE = GRID;
