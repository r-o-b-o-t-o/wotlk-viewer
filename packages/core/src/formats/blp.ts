import { BinaryReader } from '../io/BinaryReader';

export interface BlpImage {
  width: number;
  height: number;
  /** RGBA8, row 0 = top. */
  data: Uint8ClampedArray;
}

/** Decodes mip level 0 of a BLP2 texture to RGBA8. */
export function parseBlp(buffer: ArrayBuffer): BlpImage {
  const r = new BinaryReader(buffer);
  if (r.string(4) !== 'BLP2') throw new Error('Not a BLP2 file');
  const type = r.u32();
  if (type !== 1) throw new Error(`Unsupported BLP type ${type}`);
  const encoding = r.u8();
  const alphaDepth = r.u8();
  const alphaEncoding = r.u8();
  r.u8(); // hasMips
  const width = r.u32();
  const height = r.u32();
  const mipOffset = r.u32At(20);
  const mipSize = r.u32At(84);
  const data = new Uint8ClampedArray(width * height * 4);

  switch (encoding) {
    case 1: decodePalette(r, mipOffset, width, height, alphaDepth, data); break;
    case 2: decodeDxt(r.bytes, mipOffset, mipSize, width, height, alphaDepth, alphaEncoding, data); break;
    case 3: decodeRaw(r.bytes, mipOffset, width, height, data); break;
    default: throw new Error(`Unsupported BLP encoding ${encoding}`);
  }
  return { width, height, data };
}

function decodePalette(r: BinaryReader, off: number, w: number, h: number, alphaDepth: number, out: Uint8ClampedArray): void {
  const n = w * h;
  const pal = 148; // 256 BGRA palette entries follow the header
  const alphaOff = off + n;
  for (let i = 0; i < n; i++) {
    const p = pal + r.u8At(off + i) * 4;
    out[i * 4] = r.u8At(p + 2);
    out[i * 4 + 1] = r.u8At(p + 1);
    out[i * 4 + 2] = r.u8At(p);
    let a = 255;
    if (alphaDepth === 8) a = r.u8At(alphaOff + i);
    else if (alphaDepth === 1) a = (r.u8At(alphaOff + (i >> 3)) >> (i & 7)) & 1 ? 255 : 0;
    else if (alphaDepth === 4) {
      const b = r.u8At(alphaOff + (i >> 1));
      a = ((i & 1) ? b >> 4 : b & 15) * 17;
    }
    out[i * 4 + 3] = a;
  }
}

function decodeRaw(src: Uint8Array, off: number, w: number, h: number, out: Uint8ClampedArray): void {
  const n = w * h;
  for (let i = 0; i < n; i++) {
    const p = off + i * 4;
    out[i * 4] = src[p + 2];
    out[i * 4 + 1] = src[p + 1];
    out[i * 4 + 2] = src[p];
    out[i * 4 + 3] = src[p + 3];
  }
}

function decodeDxt(
  src: Uint8Array, off: number, size: number, w: number, h: number,
  alphaDepth: number, alphaEncoding: number, out: Uint8ClampedArray,
): void {
  // alphaEncoding: 0 = DXT1, 1 = DXT3, 7 = DXT5. alphaDepth <= 1 is always DXT1.
  const mode = alphaDepth <= 1 ? 1 : alphaEncoding === 7 ? 5 : alphaEncoding === 1 ? 3 : 1;
  const blockSize = mode === 1 ? 8 : 16;
  const bw = Math.max(1, w >> 2);
  const bh = Math.max(1, h >> 2);
  const c = new Uint8Array(16); // 4 palette colors, RGBA
  const alpha = new Uint8Array(16);
  let p = off;
  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++) {
      if (p + blockSize > off + size) return;
      let cp = p;
      if (mode === 3) {
        for (let i = 0; i < 8; i++) {
          const b = src[p + i];
          alpha[i * 2] = (b & 15) * 17;
          alpha[i * 2 + 1] = (b >> 4) * 17;
        }
        cp = p + 8;
      } else if (mode === 5) {
        decodeDxt5Alpha(src, p, alpha);
        cp = p + 8;
      }
      const c0 = src[cp] | (src[cp + 1] << 8);
      const c1 = src[cp + 2] | (src[cp + 3] << 8);
      rgb565(c0, c, 0);
      rgb565(c1, c, 4);
      if (mode !== 1 || c0 > c1) {
        for (let k = 0; k < 3; k++) {
          c[8 + k] = (2 * c[k] + c[4 + k] + 1) / 3;
          c[12 + k] = (c[k] + 2 * c[4 + k] + 1) / 3;
        }
        c[11] = 255; c[15] = 255;
      } else {
        for (let k = 0; k < 3; k++) {
          c[8 + k] = (c[k] + c[4 + k]) >> 1;
          c[12 + k] = 0;
        }
        c[11] = 255; c[15] = 0;
      }
      for (let y = 0; y < 4; y++) {
        const row = src[cp + 4 + y];
        const py = by * 4 + y;
        if (py >= h) break;
        for (let x = 0; x < 4; x++) {
          const px = bx * 4 + x;
          if (px >= w) break;
          const idx = (row >> (x * 2)) & 3;
          const o = (py * w + px) * 4;
          out[o] = c[idx * 4];
          out[o + 1] = c[idx * 4 + 1];
          out[o + 2] = c[idx * 4 + 2];
          out[o + 3] = mode === 1 ? c[idx * 4 + 3] : alpha[y * 4 + x];
        }
      }
      p += blockSize;
    }
  }
}

function rgb565(v: number, out: Uint8Array, o: number): void {
  const r = (v >> 11) & 31, g = (v >> 5) & 63, b = v & 31;
  out[o] = (r << 3) | (r >> 2);
  out[o + 1] = (g << 2) | (g >> 4);
  out[o + 2] = (b << 3) | (b >> 2);
  out[o + 3] = 255;
}

function decodeDxt5Alpha(src: Uint8Array, p: number, out: Uint8Array): void {
  const a0 = src[p], a1 = src[p + 1];
  const a = [a0, a1, 0, 0, 0, 0, 0, 0];
  if (a0 > a1) {
    for (let i = 1; i < 7; i++) a[i + 1] = ((7 - i) * a0 + i * a1) / 7;
  } else {
    for (let i = 1; i < 5; i++) a[i + 1] = ((5 - i) * a0 + i * a1) / 5;
    a[6] = 0; a[7] = 255;
  }
  // 16 3-bit indices packed little-endian in 6 bytes.
  let bits = 0, nbits = 0, bp = p + 2;
  for (let i = 0; i < 16; i++) {
    while (nbits < 3) { bits |= src[bp++] << nbits; nbits += 8; }
    out[i] = a[bits & 7];
    bits >>= 3; nbits -= 3;
  }
}
