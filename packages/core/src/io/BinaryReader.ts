/** Little-endian binary reader over an ArrayBuffer. */
export class BinaryReader {
  readonly view: DataView;
  readonly bytes: Uint8Array;
  pos = 0;

  constructor(buffer: ArrayBuffer, byteOffset = 0, byteLength?: number) {
    this.view = new DataView(buffer, byteOffset, byteLength);
    this.bytes = new Uint8Array(buffer, byteOffset, byteLength);
  }

  get length(): number {
    return this.view.byteLength;
  }

  seek(pos: number): this {
    this.pos = pos;
    return this;
  }

  skip(n: number): this {
    this.pos += n;
    return this;
  }

  u8(): number { return this.view.getUint8(this.pos++); }
  i8(): number { return this.view.getInt8(this.pos++); }
  u16(): number { const v = this.view.getUint16(this.pos, true); this.pos += 2; return v; }
  i16(): number { const v = this.view.getInt16(this.pos, true); this.pos += 2; return v; }
  u32(): number { const v = this.view.getUint32(this.pos, true); this.pos += 4; return v; }
  i32(): number { const v = this.view.getInt32(this.pos, true); this.pos += 4; return v; }
  f32(): number { const v = this.view.getFloat32(this.pos, true); this.pos += 4; return v; }

  u8At(o: number): number { return this.view.getUint8(o); }
  u16At(o: number): number { return this.view.getUint16(o, true); }
  i16At(o: number): number { return this.view.getInt16(o, true); }
  u32At(o: number): number { return this.view.getUint32(o, true); }
  i32At(o: number): number { return this.view.getInt32(o, true); }
  f32At(o: number): number { return this.view.getFloat32(o, true); }

  vec3(): [number, number, number] {
    return [this.f32(), this.f32(), this.f32()];
  }

  /** Fixed-length ASCII string; stops at the first NUL. */
  string(len: number): string {
    let s = '';
    for (let i = 0; i < len; i++) {
      const c = this.bytes[this.pos + i];
      if (c === 0) break;
      s += String.fromCharCode(c);
    }
    this.pos += len;
    return s;
  }

  cstringAt(o: number): string {
    let s = '';
    for (let i = o; i < this.bytes.length && this.bytes[i] !== 0; i++) s += String.fromCharCode(this.bytes[i]);
    return s;
  }

  // Typed-array copies (copying sidesteps alignment constraints of the source offset).
  u8ArrayAt(o: number, count: number): Uint8Array {
    return this.bytes.slice(o, o + count);
  }
  u16ArrayAt(o: number, count: number): Uint16Array {
    const out = new Uint16Array(count);
    for (let i = 0; i < count; i++) out[i] = this.view.getUint16(o + i * 2, true);
    return out;
  }
  i16ArrayAt(o: number, count: number): Int16Array {
    const out = new Int16Array(count);
    for (let i = 0; i < count; i++) out[i] = this.view.getInt16(o + i * 2, true);
    return out;
  }
  u32ArrayAt(o: number, count: number): Uint32Array {
    const out = new Uint32Array(count);
    for (let i = 0; i < count; i++) out[i] = this.view.getUint32(o + i * 4, true);
    return out;
  }
  f32ArrayAt(o: number, count: number): Float32Array {
    const out = new Float32Array(count);
    for (let i = 0; i < count; i++) out[i] = this.view.getFloat32(o + i * 4, true);
    return out;
  }
}
