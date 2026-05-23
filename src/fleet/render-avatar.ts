import { deflateSync } from "zlib";

const GRID = 24;
const SCALE = 21; // 24 * 21 = 504px — close to Telegram's 512x512 ideal

type RGBA = [number, number, number, number];

interface Palette {
  body: RGBA;
  shade: RGBA;
  lite: RGBA;
  ears: RGBA;
  earsDeep: RGBA;
  eyeWhite: RGBA;
  pupil: RGBA;
  mouth: RGBA;
  outline: RGBA;
  accent: RGBA;
}

const PALETTES: Palette[] = [
  { body:[243,195,58,255], shade:[201,138,30,255], lite:[253,224,122,255], ears:[196,115,46,255], earsDeep:[124,61,24,255], eyeWhite:[255,248,224,255], pupil:[26,26,26,255], mouth:[122,66,32,255], outline:[58,38,20,255], accent:[255,224,102,255] },
  { body:[240,168,122,255], shade:[196,114,74,255], lite:[255,212,173,255], ears:[212,114,74,255], earsDeep:[124,48,24,255], eyeWhite:[255,240,224,255], pupil:[42,16,16,255], mouth:[90,36,24,255], outline:[58,20,16,255], accent:[255,149,68,255] },
  { body:[159,217,122,255], shade:[94,158,62,255], lite:[213,240,176,255], ears:[90,142,58,255], earsDeep:[46,90,30,255], eyeWhite:[240,253,224,255], pupil:[14,42,14,255], mouth:[42,74,24,255], outline:[30,58,20,255], accent:[196,240,112,255] },
  { body:[160,212,240,255], shade:[94,158,196,255], lite:[212,236,255,255], ears:[90,138,184,255], earsDeep:[42,74,120,255], eyeWhite:[240,248,255,255], pupil:[14,30,58,255], mouth:[42,58,90,255], outline:[26,42,74,255], accent:[232,240,255,255] },
  { body:[184,156,216,255], shade:[126,94,168,255], lite:[224,200,240,255], ears:[126,94,168,255], earsDeep:[62,40,96,255], eyeWhite:[255,240,255,255], pupil:[30,10,42,255], mouth:[74,40,90,255], outline:[42,20,56,255], accent:[232,192,255,255] },
  { body:[240,168,192,255], shade:[196,112,144,255], lite:[255,208,224,255], ears:[196,112,144,255], earsDeep:[122,42,80,255], eyeWhite:[255,240,244,255], pupil:[42,16,24,255], mouth:[122,40,64,255], outline:[58,20,36,255], accent:[255,212,228,255] },
  { body:[232,220,184,255], shade:[168,148,106,255], lite:[250,240,208,255], ears:[168,148,106,255], earsDeep:[94,74,42,255], eyeWhite:[255,252,240,255], pupil:[26,20,16,255], mouth:[74,54,24,255], outline:[42,32,14,255], accent:[255,244,192,255] },
  { body:[106,112,144,255], shade:[58,64,96,255], lite:[160,168,200,255], ears:[58,64,96,255], earsDeep:[26,30,52,255], eyeWhite:[224,228,248,255], pupil:[255,250,204,255], mouth:[26,30,52,255], outline:[10,14,26,255], accent:[154,164,204,255] },
];

const TRANSPARENT: RGBA = [0, 0, 0, 0];

// Silhouette: 1 = body, 2 = outline (border pixels)
// Simplified 24x24 body shape
const BODY_ROWS = [
  "        111111          ",
  "       11111111         ",
  "      1111111111        ",
  "      1111111111        ",
  "     111111111111       ",
  "     111111111111       ",
  "    11111111111111      ",
  "    11111111111111      ",
  "    11111111111111      ",
  "    11111111111111      ",
  "    11111111111111      ",
  "     111111111111       ",
  "     111111111111       ",
  "      1111111111        ",
  "      1111111111        ",
  "     111111111111       ",
  "    11111111111111      ",
  "   1111111111111111     ",
  "   1111111111111111     ",
  "    11111111111111      ",
  "    11  11111111  11    ",
  "    1    111111    1    ",
  "    1     1111     1    ",
  "          1111          ",
];

function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function pick(h: number, n: number): number { return h % n; }

function renderThrongletPixels(seed: string): RGBA[][] {
  const h = fnv1a(seed);
  const pal = PALETTES[pick(h, PALETTES.length)];

  const grid: RGBA[][] = Array.from({ length: GRID }, () =>
    Array.from({ length: GRID }, () => TRANSPARENT)
  );

  // Draw body from silhouette
  for (let y = 0; y < GRID; y++) {
    const row = BODY_ROWS[y] || "";
    for (let x = 0; x < GRID; x++) {
      if (row[x] === "1") grid[y][x] = pal.body;
    }
  }

  // Outline: any body pixel adjacent to transparent gets an outline neighbor
  for (let y = 0; y < GRID; y++) {
    for (let x = 0; x < GRID; x++) {
      if (grid[y][x] !== TRANSPARENT) continue;
      const hasBody = [[-1,0],[1,0],[0,-1],[0,1]].some(([dx, dy]) => {
        const nx = x + dx, ny = y + dy;
        return ny >= 0 && ny < GRID && nx >= 0 && nx < GRID && grid[ny][nx] === pal.body;
      });
      if (hasBody) grid[y][x] = pal.outline;
    }
  }

  // Shading: bottom half of body gets shade
  for (let y = Math.floor(GRID * 0.6); y < GRID; y++) {
    for (let x = 0; x < GRID; x++) {
      if (grid[y][x] === pal.body) grid[y][x] = pal.shade;
    }
  }

  // Ears (3 variants)
  const earType = pick(h >>> 3, 3);
  if (earType === 0) {
    // Pointed ears
    grid[2][5] = pal.ears; grid[1][5] = pal.ears; grid[0][6] = pal.ears;
    grid[2][18] = pal.ears; grid[1][18] = pal.ears; grid[0][17] = pal.ears;
  } else if (earType === 1) {
    // Round ears
    grid[2][5] = pal.ears; grid[1][5] = pal.ears; grid[1][6] = pal.ears;
    grid[2][18] = pal.ears; grid[1][18] = pal.ears; grid[1][17] = pal.ears;
  } else {
    // Floppy ears
    grid[4][3] = pal.ears; grid[5][3] = pal.ears; grid[6][3] = pal.ears;
    grid[4][20] = pal.ears; grid[5][20] = pal.ears; grid[6][20] = pal.ears;
  }

  // Eyes
  const eyeType = pick(h >>> 7, 4);
  const eyeY = 7;
  const lx = 8, rx = 14;
  grid[eyeY][lx] = pal.eyeWhite; grid[eyeY][lx+1] = pal.eyeWhite;
  grid[eyeY+1][lx] = pal.eyeWhite; grid[eyeY+1][lx+1] = pal.eyeWhite;
  grid[eyeY][rx] = pal.eyeWhite; grid[eyeY][rx+1] = pal.eyeWhite;
  grid[eyeY+1][rx] = pal.eyeWhite; grid[eyeY+1][rx+1] = pal.eyeWhite;

  if (eyeType === 0) {
    grid[eyeY+1][lx+1] = pal.pupil;
    grid[eyeY+1][rx+1] = pal.pupil;
  } else if (eyeType === 1) {
    grid[eyeY][lx+1] = pal.pupil;
    grid[eyeY][rx+1] = pal.pupil;
  } else if (eyeType === 2) {
    grid[eyeY+1][lx] = pal.pupil;
    grid[eyeY+1][rx] = pal.pupil;
  } else {
    grid[eyeY][lx] = pal.pupil; grid[eyeY+1][lx+1] = pal.pupil;
    grid[eyeY][rx+1] = pal.pupil; grid[eyeY+1][rx] = pal.pupil;
  }

  // Mouth
  const mouthType = pick(h >>> 11, 3);
  const my = 11;
  const mx = 11;
  if (mouthType === 0) {
    grid[my][mx-1] = pal.mouth; grid[my][mx] = pal.mouth; grid[my][mx+1] = pal.mouth;
  } else if (mouthType === 1) {
    grid[my][mx] = pal.mouth;
    grid[my+1][mx-1] = pal.mouth; grid[my+1][mx+1] = pal.mouth;
  } else {
    grid[my][mx-1] = pal.mouth; grid[my][mx] = pal.mouth; grid[my][mx+1] = pal.mouth;
    grid[my+1][mx] = pal.mouth;
  }

  // Chest marking
  const chestType = pick(h >>> 15, 3);
  if (chestType === 0) {
    for (let cx = 9; cx <= 14; cx++) {
      if (grid[14][cx] !== TRANSPARENT) grid[14][cx] = pal.lite;
      if (grid[15][cx] !== TRANSPARENT) grid[15][cx] = pal.lite;
    }
  } else if (chestType === 1) {
    grid[14][11] = pal.accent; grid[14][12] = pal.accent;
    grid[15][10] = pal.accent; grid[15][13] = pal.accent;
  }

  // Horn / antenna
  const hornType = pick(h >>> 19, 3);
  if (hornType === 1) {
    grid[1][11] = pal.accent; grid[0][11] = pal.accent;
    grid[1][12] = pal.accent; grid[0][12] = pal.accent;
  } else if (hornType === 2) {
    grid[1][9] = pal.accent; grid[0][8] = pal.accent;
    grid[1][14] = pal.accent; grid[0][15] = pal.accent;
  }

  return grid;
}

function encodePNG(pixels: RGBA[][], width: number, height: number): Buffer {
  // PNG signature
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  // IHDR chunk
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type: RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace
  const ihdrChunk = makeChunk("IHDR", ihdr);

  // IDAT: raw pixel data with filter byte per row
  const rawSize = height * (1 + width * 4);
  const raw = Buffer.alloc(rawSize);
  let offset = 0;
  for (let y = 0; y < height; y++) {
    raw[offset++] = 0; // filter: none
    const srcY = Math.floor(y / SCALE);
    for (let x = 0; x < width; x++) {
      const srcX = Math.floor(x / SCALE);
      const [r, g, b, a] = pixels[srcY]?.[srcX] ?? TRANSPARENT;
      raw[offset++] = r;
      raw[offset++] = g;
      raw[offset++] = b;
      raw[offset++] = a;
    }
  }
  const compressed = deflateSync(raw);
  const idatChunk = makeChunk("IDAT", compressed);

  // IEND
  const iendChunk = makeChunk("IEND", Buffer.alloc(0));

  return Buffer.concat([sig, ihdrChunk, idatChunk, iendChunk]);
}

function makeChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBytes = Buffer.from(type, "ascii");
  const payload = Buffer.concat([typeBytes, data]);
  const crc = crc32(payload);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc >>> 0, 0);
  return Buffer.concat([len, payload, crcBuf]);
}

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return c ^ 0xffffffff;
}

const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) {
    c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
  }
  CRC_TABLE[n] = c;
}

export function renderAvatarPNG(seed: string): Buffer {
  const pixels = renderThrongletPixels(seed);
  const size = GRID * SCALE;
  return encodePNG(pixels, size, size);
}
