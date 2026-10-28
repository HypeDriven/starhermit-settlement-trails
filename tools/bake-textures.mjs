// Bakes the browser build's procedural textures (js/render.js noiseCanvas →
// makeGroundTexture / makeWaterNormal, unchanged maths) into PNGs for every
// budget size (gfx.js BUDGETS texture: 64–512 px; the water normal map at
// half), so the engine client loads them instead of running ~260k-pixel noise
// loops in the native interpreter: assets/textures/ground-N.png (grey grain,
// sRGB) and water-N.png (tangent-space normals, linear).
//   node tools/bake-textures.mjs
import { writeFileSync, mkdirSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { RngStream } from '../js/rng.js';

const OUT = new URL('../assets/textures/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

function noiseCanvas(size, seed, octaves = 3) {
  const rng = new RngStream(seed >>> 0, 'tex');
  const grids = [];
  for (let o = 0; o < octaves; o++) {
    const n = 4 << o;
    const g = new Float32Array(n * n);
    for (let i = 0; i < g.length; i++) g[i] = rng.float();
    grids.push({ n, g });
  }
  const out = new Float32Array(size * size);
  const smooth = (t) => t * t * (3 - 2 * t);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let v = 0, amp = 1, tot = 0;
      for (const { n, g } of grids) {
        const fx = x / size * n, fy = y / size * n;
        const x0 = Math.floor(fx), y0 = Math.floor(fy);
        const tx = smooth(fx - x0), ty = smooth(fy - y0);
        const at = (a, b) => g[((b % n) * n) + (a % n)];
        const a = at(x0, y0) + (at(x0 + 1, y0) - at(x0, y0)) * tx;
        const b = at(x0, y0 + 1) + (at(x0 + 1, y0 + 1) - at(x0, y0 + 1)) * tx;
        v += (a + (b - a) * ty) * amp; tot += amp; amp *= 0.5;
      }
      out[y * size + x] = v / tot;
    }
  }
  return out;
}
function ground(size) {
  const n = noiseCanvas(size, 0x51ee7, 4);
  const px = new Uint8Array(size * size * 4);
  for (let i = 0; i < n.length; i++) {
    const v = Math.round(255 * (0.84 + 0.16 * n[i]) * (0.97 + 0.03 * ((i * 2654435761) % 997) / 997));
    px[i * 4] = v; px[i * 4 + 1] = v; px[i * 4 + 2] = v; px[i * 4 + 3] = 255;
  }
  return px;
}
function water(size) {
  const h = noiseCanvas(size, 0xa11ce, 3);
  const px = new Uint8Array(size * size * 4);
  const at = (x, y) => h[((y + size) % size) * size + ((x + size) % size)];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (at(x + 1, y) - at(x - 1, y)) * 3, dy = (at(x, y + 1) - at(x, y - 1)) * 3;
      const len = Math.hypot(dx, dy, 1);
      const i = (y * size + x) * 4;
      px[i] = Math.round((-dx / len * 0.5 + 0.5) * 255);
      px[i + 1] = Math.round((-dy / len * 0.5 + 0.5) * 255);
      px[i + 2] = Math.round((1 / len * 0.5 + 0.5) * 255);
      px[i + 3] = 255;
    }
  }
  return px;
}
const CRC = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
const crc32 = (buf) => { let c = -1; for (const b of buf) c = CRC[(c ^ b) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; };
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) { raw[y * (size * 4 + 1)] = 0; Buffer.from(rgba.buffer, y * size * 4, size * 4).copy(raw, y * (size * 4 + 1) + 1); }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}
for (const s of [64, 128, 256, 512]) writeFileSync(OUT + `ground-${s}.png`, png(s, ground(s)));
for (const s of [32, 64, 128, 256]) writeFileSync(OUT + `water-${s}.png`, png(s, water(s)));
console.log('baked', OUT);
