/**
 * Regenerates src/icons.ts.
 *
 * The Worker cannot compress a PNG at runtime, so the artwork is drawn here and
 * embedded as base64. Keeping the generator in the repo means adding a bundle is
 * `npm run icons` rather than a hand-made blob nobody can edit.
 *
 * Usage: node scripts/generate-icons.mjs
 */
import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const SIZE = 128;
const SAMPLES = 3; // supersampling factor, so edges are not jagged
const CORNER = 0.2; // corner radius as a fraction of the tile

const CRC_TABLE = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  return value >>> 0;
});

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const payload = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(payload));
  return Buffer.concat([length, payload, crc]);
}

function encodePng(pixels) {
  const stride = SIZE * 4;
  const raw = Buffer.alloc(SIZE * (1 + stride));
  for (let y = 0; y < SIZE; y += 1) {
    raw[y * (1 + stride)] = 0; // filter type 0 (None)
    pixels.copy(raw, y * (1 + stride) + 1, y * stride, (y + 1) * stride);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(SIZE, 0);
  header.writeUInt32BE(SIZE, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // colour type: RGBA
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Signed distance to a rounded square centred on the tile, in 0..1 space. */
function insideTile(x, y) {
  const radius = CORNER;
  const dx = Math.max(Math.abs(x - 0.5) - (0.5 - radius), 0);
  const dy = Math.max(Math.abs(y - 0.5) - (0.5 - radius), 0);
  return Math.hypot(dx, dy) <= radius;
}

function band(y, centre, half) {
  return Math.abs(y - centre) <= half;
}

function roundedRect(x, y, left, top, right, bottom, radius) {
  if (x < left || x > right || y < top || y > bottom) return false;
  const dx = Math.max(left + radius - x, x - (right - radius), 0);
  const dy = Math.max(top + radius - y, y - (bottom - radius), 0);
  return Math.hypot(dx, dy) <= radius;
}

const GLYPHS = {
  /** Water, for the source itself. */
  waves: (x, y) =>
    [0.36, 0.52, 0.68].some((centre) =>
      band(y, centre + 0.05 * Math.sin((x - 0.18) * Math.PI * 2.6), 0.035),
    ) &&
    x > 0.16 &&
    x < 0.84,
  /** Stacked cards, for the merged feed. */
  stack: (x, y) =>
    [
      [0.3, 0.26, 0.7],
      [0.47, 0.2, 0.76],
      [0.64, 0.26, 0.7],
    ].some(([top, left, right]) => roundedRect(x, y, left, top, right, top + 0.1, 0.035)),
  /** A grid of tiles, for the mainstream bundle. */
  grid: (x, y) =>
    [0.3, 0.56].some((top) =>
      [0.24, 0.42, 0.6].some((left) => roundedRect(x, y, left, top, left + 0.16, top + 0.16, 0.04)),
    ),
  /** A ring, for creator uploads. */
  ring: (x, y) => {
    const distance = Math.hypot(x - 0.5, y - 0.5);
    return distance <= 0.26 && distance >= 0.16;
  },
  /** A portrait frame, for vertical short-form video. */
  portrait: (x, y) =>
    roundedRect(x, y, 0.37, 0.2, 0.63, 0.8, 0.05) &&
    !roundedRect(x, y, 0.41, 0.24, 0.59, 0.76, 0.03),
  /** A four-point sparkle, for animation. */
  sparkle: (x, y) => {
    const dx = Math.abs(x - 0.5) / 0.32;
    const dy = Math.abs(y - 0.5) / 0.32;
    return Math.pow(dx, 0.55) + Math.pow(dy, 0.55) <= 1;
  },
  /** A solid disc, for the Asian catalogue bundle. */
  disc: (x, y) => Math.hypot(x - 0.5, y - 0.5) <= 0.25,
  /** A screen with a play triangle, for the second tier of large tubes. */
  screen: (x, y) => {
    const frame =
      roundedRect(x, y, 0.22, 0.3, 0.78, 0.7, 0.06) &&
      !roundedRect(x, y, 0.26, 0.34, 0.74, 0.66, 0.04);
    // Triangle pointing right, centred in the frame.
    const inTriangle =
      x >= 0.44 && x <= 0.6 && Math.abs(y - 0.5) <= (0.6 - x) * (0.14 / 0.16) + 0.001;
    return frame || inTriangle;
  },
  /** Two interlocking rings, for the fetish and kink bundle. */
  links: (x, y) => {
    const ring = (cx) => {
      const distance = Math.hypot(x - cx, y - 0.5);
      return distance <= 0.2 && distance >= 0.12;
    };
    return ring(0.38) || ring(0.62);
  },
};

const ICONS = [
  { name: "source", colour: [0xff, 0x6b, 0x35], glyph: "waves" },
  { name: "all", colour: [0x1f, 0x29, 0x33], glyph: "stack" },
  { name: "mainstream", colour: [0x25, 0x63, 0xeb], glyph: "grid" },
  { name: "amateur", colour: [0xdb, 0x27, 0x77], glyph: "ring" },
  { name: "shorts", colour: [0x7c, 0x3a, 0xed], glyph: "portrait" },
  { name: "anime", colour: [0x05, 0x96, 0x69], glyph: "sparkle" },
  { name: "asian", colour: [0xdc, 0x26, 0x26], glyph: "disc" },
  { name: "tubes", colour: [0x0d, 0x94, 0x88], glyph: "screen" },
  { name: "fetish", colour: [0xd9, 0x77, 0x06], glyph: "links" },
];

function render({ colour, glyph }) {
  const draw = GLYPHS[glyph];
  const pixels = Buffer.alloc(SIZE * SIZE * 4);
  for (let py = 0; py < SIZE; py += 1) {
    for (let px = 0; px < SIZE; px += 1) {
      let covered = 0;
      let inked = 0;
      for (let sy = 0; sy < SAMPLES; sy += 1) {
        for (let sx = 0; sx < SAMPLES; sx += 1) {
          const x = (px + (sx + 0.5) / SAMPLES) / SIZE;
          const y = (py + (sy + 0.5) / SAMPLES) / SIZE;
          if (!insideTile(x, y)) continue;
          covered += 1;
          if (draw(x, y)) inked += 1;
        }
      }
      const total = SAMPLES * SAMPLES;
      const alpha = Math.round((covered / total) * 255);
      const ink = covered === 0 ? 0 : inked / covered;
      const offset = (py * SIZE + px) * 4;
      for (let channel = 0; channel < 3; channel += 1) {
        pixels[offset + channel] = Math.round(colour[channel] + (255 - colour[channel]) * ink);
      }
      pixels[offset + 3] = alpha;
    }
  }
  return encodePng(pixels);
}

function wrap(base64) {
  return (base64.match(/.{1,96}/g) ?? []).map((line) => `  "${line}"`).join(" +\n");
}

const entries = ICONS.map((icon) => ({ name: icon.name, base64: render(icon).toString("base64") }));

const file = `/**
 * Icons served by the Worker itself.
 *
 * Hot Tub fetches source and channel artwork over the network, and every route
 * here is behind the VPN allowlist, so pointing at a third-party favicon service
 * would leak requests for no benefit. These PNGs are drawn by
 * \`scripts/generate-icons.mjs\` and embedded as base64; run \`npm run icons\`
 * after changing that script. Do not hand-edit the literals below.
 */
function decode(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

const ICON_BASE64: Record<string, string> = {
${entries.map((entry) => `  ${JSON.stringify(entry.name)}:\n${wrap(entry.base64)},`).join("\n")}
};

const cache = new Map<string, Uint8Array>();

/** Decoded once per isolate, then reused for every request. */
export function iconPng(name: string): Uint8Array | undefined {
  const cached = cache.get(name);
  if (cached) return cached;
  const base64 = ICON_BASE64[name];
  if (!base64) return undefined;
  const bytes = decode(base64);
  cache.set(name, bytes);
  return bytes;
}

export function hasIcon(name: string): boolean {
  return name in ICON_BASE64;
}

export const sourceIconPng = iconPng("source")!;
export const allChannelIconPng = iconPng("all")!;
`;

const target = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "icons.ts");
writeFileSync(target, file);
console.log(
  `wrote ${target}\n` +
    entries
      .map((entry) => `  ${entry.name}: ${Math.ceil((entry.base64.length * 3) / 4)} bytes`)
      .join("\n"),
);
