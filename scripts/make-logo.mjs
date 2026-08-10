#!/usr/bin/env node
// Draws the Skeddy Goblin mark: a 32x32 pixel sprite, upscaled with nearest-neighbour
// so it stays crisp, plus an SVG of the same grid (one rect per run of pixels).
//
//   npm run logo
//
// Everything lands in assets/logo/. Edit the sprite grid below and re-run.

import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'logo');

const PALETTE = {
  '.': null, // transparent
  o: '#1b1420', // outline
  k: '#3b2a63', // hood, shadow
  h: '#5b3fa8', // hood, mid
  H: '#7d5fd6', // hood, lit
  d: '#2f6b28', // skin, shadow
  g: '#57a83c', // skin, mid
  G: '#8fd45c', // skin, lit
  e: '#fdf6e3', // sclera
  p: '#1b1420', // pupil
  m: '#6d1230', // mouth
  t: '#fdf6e3', // teeth
  y: '#ffc23c', // gold
  Y: '#ffe79a', // gold, lit
  b: '#14121c', // banner background
};

const SIZE = 32;

/**
 * The sprite is authored as row spans — `[row, col, 'chars']` — rather than 32
 * hand-counted strings, so a column is never off by one. Later spans paint over
 * earlier ones, which is what lets the ears and eyes sit on top of the face.
 */
const SPANS = [
  // hood, crown to brim — the peak leans right into a floppy tip
  [2, 12, 'oooooooo'],
  [3, 10, 'ooHHHHHHHHoo'],
  [4, 9, 'okHHHHHHHHHHko'],
  [5, 8, 'okHHHHHHHhhhhhko'],
  [6, 7, 'okHHHHHhhhhhhhhhko'],
  [7, 6, 'okHHHHHhhhhhhhhhhhko'],
  [8, 6, 'okHHHHhhhhhhhhhhhhko'],
  [9, 5, 'okHHHHhhhhhhhhhhhhhhko'],
  [10, 5, 'okkkkkkkkkkkkkkkkkkkko'],
  [11, 5, 'oooooooooooooooooooooo'],

  // floppy tip, painted over the dome so the two merge
  [0, 21, 'ooo'],
  [1, 20, 'oHHko'],
  [2, 19, 'oHHHkko'],
  [3, 20, 'HHkkoo'],
  [4, 23, 'oo'],

  // face
  [12, 8, 'oddddddddddddddo'],
  [13, 8, 'oddddddddddddddo'],
  [14, 8, 'ogggggggggggggdo'],
  [15, 8, 'ogggggggggggggdo'],
  [16, 8, 'ogggggggggggggdo'],
  [17, 8, 'ogggggggggggggdo'],
  [18, 8, 'ogggggggggggggdo'],
  [19, 8, 'ogggggggggggggdo'],
  [20, 8, 'ogggggggggggggdo'],
  [21, 8, 'ogggggggggggggdo'],
  [22, 8, 'ogggggggggggggdo'],
  [23, 8, 'ogggggggggggggdo'],
  [24, 8, 'ogggggggggggggdo'],
  [25, 9, 'oggggggggggggdo'],
  [26, 10, 'oggggggggggdo'],
  [27, 11, 'oggggggggdo'],
  [28, 12, 'oooooooo'],

  // brows
  [15, 10, 'ooooo'],
  [15, 17, 'ooooo'],

  // eyes
  [16, 10, 'oeeee'],
  [16, 17, 'eeeeo'],
  [17, 10, 'oeppe'],
  [17, 17, 'eppeo'],
  [18, 10, 'oeppe'],
  [18, 17, 'eppeo'],
  [19, 10, 'ooooo'],
  [19, 17, 'ooooo'],

  // nose
  [20, 15, 'dd'],
  [21, 14, 'dGGd'],
  [22, 14, 'o'],
  [22, 17, 'o'],

  // grin
  [23, 10, 'oooooooooooo'],
  [24, 10, 'ommttmmmmttmo'],
  [25, 11, 'ommmmttmmmmo'],
  [26, 12, 'oooooooo'],

  // cloak collar
  [29, 4, 'oHHHHHHHHHHHHHHHHHHHHHHo'],
  [30, 3, 'ohhhhhhhhhhhhhhhhhhhhhhhho'],
  [31, 3, 'okkkkkkkkkkkkkkkkkkkkkkkko'],

  // gold clock clasp
  [29, 14, 'oooo'],
  [30, 14, 'oYyo'],
  [31, 14, 'oyyo'],
];

// The left ear, mirrored onto the right below. Sits over the face outline.
const EAR_SPANS = [
  [14, 4, 'ooooo'],
  [15, 2, 'ooGGggg'],
  [16, 1, 'oGGggggg'],
  [17, 1, 'oogggggg'],
  [18, 3, 'ooggggg'],
  [19, 5, 'oogg'],
  [20, 7, 'oo'],
];

function buildGrid() {
  const grid = Array.from({ length: SIZE }, () => Array(SIZE).fill('.'));
  const paint = (row, col, chars) => {
    for (let i = 0; i < chars.length; i += 1) {
      const x = col + i;
      if (row >= 0 && row < SIZE && x >= 0 && x < SIZE) grid[row][x] = chars[i];
    }
  };

  for (const [row, col, chars] of SPANS) paint(row, col, chars);
  for (const [row, col, chars] of EAR_SPANS) {
    paint(row, col, chars);
    // mirror across the sprite's vertical centre line
    const mirrored = [...chars].reverse().join('');
    paint(row, SIZE - col - chars.length, mirrored);
  }
  return grid;
}

// --- 5x7 pixel type, for the wordmark -------------------------------------

const GLYPHS = {
  S: ['.####', '#....', '#....', '.###.', '....#', '....#', '####.'],
  K: ['#...#', '#..#.', '#.#..', '##...', '#.#..', '#..#.', '#...#'],
  E: ['#####', '#....', '#....', '####.', '#....', '#....', '#####'],
  D: ['####.', '#...#', '#...#', '#...#', '#...#', '#...#', '####.'],
  Y: ['#...#', '#...#', '.#.#.', '..#..', '..#..', '..#..', '..#..'],
  G: ['.###.', '#...#', '#....', '#.###', '#...#', '#...#', '.###.'],
  O: ['.###.', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
  B: ['####.', '#...#', '#...#', '####.', '#...#', '#...#', '####.'],
  L: ['#....', '#....', '#....', '#....', '#....', '#....', '#####'],
  I: ['#####', '..#..', '..#..', '..#..', '..#..', '..#..', '#####'],
  N: ['#...#', '##..#', '##..#', '#.#.#', '#..##', '#..##', '#...#'],
};

const GLYPH_W = 5;
const GLYPH_H = 7;
const TRACKING = 1;

function textWidth(word) {
  return word.length * (GLYPH_W + TRACKING) - TRACKING;
}

function drawText(canvas, word, originX, originY, fill, shadow) {
  word.split('').forEach((char, index) => {
    const glyph = GLYPHS[char];
    if (!glyph) throw new Error(`no glyph for ${char}`);
    const x0 = originX + index * (GLYPH_W + TRACKING);
    for (let y = 0; y < GLYPH_H; y += 1) {
      for (let x = 0; x < GLYPH_W; x += 1) {
        if (glyph[y][x] !== '#') continue;
        if (shadow) canvas.set(x0 + x + 1, originY + y + 1, shadow);
        canvas.set(x0 + x, originY + y, fill);
      }
    }
  });
}

// --- canvas ---------------------------------------------------------------

function createCanvas(width, height, fill = '.') {
  const cells = Array.from({ length: height }, () => Array(width).fill(fill));
  return {
    width,
    height,
    cells,
    set(x, y, char) {
      if (x >= 0 && x < width && y >= 0 && y < height) cells[y][x] = char;
    },
    blit(grid, originX, originY) {
      grid.forEach((row, y) => {
        row.forEach((char, x) => {
          if (char !== '.') this.set(originX + x, originY + y, char);
        });
      });
    },
  };
}

// --- PNG ------------------------------------------------------------------

function crc32(buf) {
  let crc = ~0;
  for (const byte of buf) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return ~crc >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function rgba(hex) {
  if (!hex) return [0, 0, 0, 0];
  return [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
    255,
  ];
}

/** Nearest-neighbour upscale, so pixels stay square instead of blurring. */
function encodePng(cells, scale) {
  const height = cells.length * scale;
  const width = cells[0].length * scale;
  const raw = Buffer.alloc(height * (width * 4 + 1));
  let offset = 0;
  for (let y = 0; y < height; y += 1) {
    raw[offset] = 0; // filter: none
    offset += 1;
    const row = cells[Math.floor(y / scale)];
    for (let x = 0; x < width; x += 1) {
      const [r, g, b, a] = rgba(PALETTE[row[Math.floor(x / scale)]]);
      raw[offset] = r;
      raw[offset + 1] = g;
      raw[offset + 2] = b;
      raw[offset + 3] = a;
      offset += 4;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // truecolour + alpha
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// --- SVG ------------------------------------------------------------------

/**
 * One rect per horizontal run of same-coloured pixels, so the file stays small.
 * `background`, if given, is drawn once underneath instead of run by run.
 */
function encodeSvg(cells, background) {
  const height = cells.length;
  const width = cells[0].length;
  const rects = [];
  if (background) {
    rects.push(
      `<rect x="0" y="0" width="${width}" height="${height}" fill="${PALETTE[background]}"/>`,
    );
  }
  for (let y = 0; y < height; y += 1) {
    let x = 0;
    while (x < width) {
      const char = cells[y][x];
      let run = 1;
      while (x + run < width && cells[y][x + run] === char) run += 1;
      if (PALETTE[char] && char !== background) {
        rects.push(`<rect x="${x}" y="${y}" width="${run}" height="1" fill="${PALETTE[char]}"/>`);
      }
      x += run;
    }
  }
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}"`,
    ` width="${width}" height="${height}" shape-rendering="crispEdges">`,
    `<title>Skeddy Goblin</title>`,
    rects.join(''),
    '</svg>',
    '',
  ].join('');
}

// --- compose --------------------------------------------------------------

function buildBanner(grid) {
  const padding = 5;
  const gap = 6;
  const word = 'SKEDDY';
  const textX = padding + SIZE + gap;
  const width = textX + textWidth(word) + 1 + padding;
  const height = SIZE + padding * 2;

  const canvas = createCanvas(width, height, 'b');
  canvas.blit(grid, padding, padding);

  const textY = padding + Math.floor((SIZE - (GLYPH_H * 2 + 4)) / 2);
  drawText(canvas, word, textX, textY, 'Y', 'o');
  drawText(canvas, 'GOBLIN', textX, textY + GLYPH_H + 4, 'G', 'o');
  return canvas;
}

function write(name, data) {
  writeFileSync(join(OUT_DIR, name), data);
  console.log(`assets/logo/${name}`);
}

mkdirSync(OUT_DIR, { recursive: true });

const grid = buildGrid();
write('mark.svg', encodeSvg(grid));
for (const scale of [1, 4, 8, 16]) {
  write(`mark-${SIZE * scale}.png`, encodePng(grid, scale));
}

const banner = buildBanner(grid);
write('banner.svg', encodeSvg(banner.cells, 'b'));
write('banner.png', encodePng(banner.cells, 8));
