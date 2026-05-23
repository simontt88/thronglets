export const GRID = 24;

export type PaletteName = "amber" | "ember" | "mint" | "frost" | "dusk" | "rose" | "bone" | "ink";

export type TraitName = "curious" | "sleepy" | "eager" | "chaotic" | "calm" | "skeptical";

export type MoodName =
  | "idle"
  | "working"
  | "talking"
  | "happy"
  | "skeptical"
  | "sleeping"
  | "dead";

export type ColorIdx = number;

export interface Palette {
  bg: string;
  body: string;
  bodyShade: string;
  bodyLite: string;
  ears: string;
  earsDeep: string;
  eyeWhite: string;
  pupil: string;
  mouth: string;
  sash: string;
  sashShade: string;
  outline: string;
  accent: string;
}

export const COLOR = {
  TRANSPARENT: 0,
  BODY: 1,
  BODY_SHADE: 2,
  BODY_LITE: 3,
  EARS: 4,
  EARS_DEEP: 5,
  EYE_WHITE: 6,
  PUPIL: 7,
  MOUTH: 8,
  SASH: 9,
  SASH_SHADE: 10,
  OUTLINE: 11,
  ACCENT: 12,
} as const;

export type ColorKey = (typeof COLOR)[keyof typeof COLOR];

export interface ThrongletSpec {
  name: string;
  seed: number;
  palette: PaletteName;
  ears: number;
  eyes: number;
  mouth: number;
  horn: number;
  chest: number;
  trait: TraitName;
}

export type PixelGrid = Uint8Array;

export function emptyGrid(): PixelGrid {
  return new Uint8Array(GRID * GRID);
}

export function setPx(g: PixelGrid, x: number, y: number, c: ColorKey): void {
  if (x < 0 || y < 0 || x >= GRID || y >= GRID) return;
  g[y * GRID + x] = c;
}

export function getPx(g: PixelGrid, x: number, y: number): ColorKey {
  if (x < 0 || y < 0 || x >= GRID || y >= GRID) return COLOR.TRANSPARENT;
  return g[y * GRID + x] as ColorKey;
}
