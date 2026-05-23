import { COLOR, type PixelGrid, setPx } from "../types";
import { ANCHORS } from "../species";

// 5 ear variants. Each function draws BOTH ears (left mirrored to right).
// All ears occupy roughly a 4-wide x 4-tall area above the head.

type EarFn = (g: PixelGrid) => void;

// 0: round button ears (matches reference sticker exactly)
const earRound: EarFn = (g) => {
  drawEar(g, "round");
};

// 1: tall pointed cat ears
const earCat: EarFn = (g) => {
  drawEar(g, "cat");
};

// 2: floppy droopy ears
const earFloppy: EarFn = (g) => {
  drawEar(g, "floppy");
};

// 3: leaf-tip ears (mint thronglet vibe)
const earLeaf: EarFn = (g) => {
  drawEar(g, "leaf");
};

// 4: tiny stub ears (almost none)
const earStub: EarFn = (g) => {
  drawEar(g, "stub");
};

function drawEar(g: PixelGrid, style: "round" | "cat" | "floppy" | "leaf" | "stub"): void {
  const L = ANCHORS.leftEar;   // (3, 3)
  const R = ANCHORS.rightEar;  // (16, 3)

  if (style === "round") {
    // 5-wide round bump that sits on top of the head
    drawShape(g, L.x, L.y, [
      ".OOO.",
      "Obbb O",  // intentional space to mark padding
      "ObEbO",
      "OObOO",
    ], true);
    drawShape(g, R.x, R.y, [
      ".OOO.",
      "ObbbO",
      "ObEbO",
      "OObOO",
    ]);
  } else if (style === "cat") {
    // Pointed up like cat ears
    drawShape(g, L.x, L.y - 1, [
      "..O..",
      ".OEO.",
      "ObEbO",
      "ObEbO",
      "OObOO",
    ]);
    drawShape(g, R.x, R.y - 1, [
      "..O..",
      ".OEO.",
      "ObEbO",
      "ObEbO",
      "OObOO",
    ]);
  } else if (style === "floppy") {
    // Droopy — start at root then hang down outside head
    drawShape(g, L.x - 1, L.y, [
      ".OOO.",
      "ObbbO",
      "ObEbO",
      ".ObO.",
      ".OOO.",
    ]);
    drawShape(g, R.x + 1, R.y, [
      ".OOO.",
      "ObbbO",
      "ObEbO",
      ".ObO.",
      ".OOO.",
    ]);
  } else if (style === "leaf") {
    // Pointed asymmetric leaf
    drawShape(g, L.x, L.y - 1, [
      "..O..",
      ".OEO.",
      "OEEbO",
      "ObEbO",
      "OObOO",
    ]);
    drawShape(g, R.x, R.y - 1, [
      "..O..",
      ".OEO.",
      "ObEEO",
      "ObEbO",
      "OObOO",
    ]);
  } else if (style === "stub") {
    drawShape(g, L.x + 1, L.y + 1, [
      "OOO",
      "ObO",
      "OOO",
    ]);
    drawShape(g, R.x + 1, R.y + 1, [
      "OOO",
      "ObO",
      "OOO",
    ]);
  }
}

function drawShape(g: PixelGrid, x0: number, y0: number, rows: string[], _silent?: boolean): void {
  for (let dy = 0; dy < rows.length; dy++) {
    const row = rows[dy];
    for (let dx = 0; dx < row.length; dx++) {
      const ch = row.charAt(dx);
      if (ch === "b") setPx(g, x0 + dx, y0 + dy, COLOR.BODY);
      else if (ch === "E") setPx(g, x0 + dx, y0 + dy, COLOR.EARS);
      else if (ch === "D") setPx(g, x0 + dx, y0 + dy, COLOR.EARS_DEEP);
      else if (ch === "O") setPx(g, x0 + dx, y0 + dy, COLOR.OUTLINE);
      else if (ch === "L") setPx(g, x0 + dx, y0 + dy, COLOR.BODY_LITE);
      // '.' and ' ' = skip (leave existing pixel)
    }
  }
}

export const EARS: EarFn[] = [earRound, earCat, earFloppy, earLeaf, earStub];
