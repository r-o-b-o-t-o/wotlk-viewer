import { BinaryReader } from '../io/BinaryReader';

/** .skin file (M2 skin profile): index buffer, submeshes and render batches. */

export interface SkinSubmesh {
  /** Geoset id (e.g. 0 body, 1-99 hair, 401 hands, ...). */
  id: number;
  vertexStart: number;
  vertexCount: number;
  indexStart: number;
  indexCount: number;
  boneCount: number;
  boneComboIndex: number;
  boneInfluences: number;
  centerBoneIndex: number;
  center: [number, number, number];
  sortCenter: [number, number, number];
  sortRadius: number;
}

export interface SkinBatch {
  flags: number;
  priorityPlane: number;
  shaderId: number;
  submeshIndex: number;
  geosetIndex: number; // duplicate of submeshIndex
  colorIndex: number; // into m2.colors, -1 = none
  materialIndex: number;
  materialLayer: number;
  textureCount: number;
  textureComboIndex: number; // into m2.textureLookup
  textureCoordComboIndex: number; // into m2.textureUnitLookup
  textureWeightComboIndex: number; // into m2.transparencyLookup
  textureTransformComboIndex: number; // into m2.textureTransformLookup
}

export interface SkinData {
  /** Indices into the M2 vertex list. */
  vertices: Uint16Array;
  /** Triangle list indexing `vertices`. */
  indices: Uint16Array;
  submeshes: SkinSubmesh[];
  batches: SkinBatch[];
  boneCountMax: number;
}

export function parseSkin(buffer: ArrayBuffer): SkinData {
  const r = new BinaryReader(buffer);
  if (r.string(4) !== 'SKIN') throw new Error('Not a SKIN file');
  const verts = { count: r.u32(), offset: r.u32() };
  const idx = { count: r.u32(), offset: r.u32() };
  r.skip(8); // bones (per-vertex bone lookup, unused: M2 vertices carry global bone indices)
  const sub = { count: r.u32(), offset: r.u32() };
  const bat = { count: r.u32(), offset: r.u32() };
  const boneCountMax = r.u32();

  const submeshes: SkinSubmesh[] = [];
  for (let i = 0; i < sub.count; i++) {
    r.seek(sub.offset + i * 48);
    const id = r.u16();
    const level = r.u16();
    const vertexStart = r.u16();
    const vertexCount = r.u16();
    const indexStart = r.u16() + (level << 16);
    const indexCount = r.u16();
    const boneCount = r.u16();
    const boneComboIndex = r.u16();
    const boneInfluences = r.u16();
    const centerBoneIndex = r.u16();
    const center = r.vec3();
    const sortCenter = r.vec3();
    const sortRadius = r.f32();
    submeshes.push({
      id, vertexStart, vertexCount, indexStart, indexCount, boneCount, boneComboIndex,
      boneInfluences, centerBoneIndex, center, sortCenter, sortRadius,
    });
  }

  const batches: SkinBatch[] = [];
  for (let i = 0; i < bat.count; i++) {
    r.seek(bat.offset + i * 24);
    batches.push({
      flags: r.u8(),
      priorityPlane: r.i8(),
      shaderId: r.u16(),
      submeshIndex: r.u16(),
      geosetIndex: r.u16(),
      colorIndex: r.i16(),
      materialIndex: r.u16(),
      materialLayer: r.u16(),
      textureCount: r.u16(),
      textureComboIndex: r.u16(),
      textureCoordComboIndex: r.u16(),
      textureWeightComboIndex: r.u16(),
      textureTransformComboIndex: r.u16(),
    });
  }

  return {
    vertices: r.u16ArrayAt(verts.offset, verts.count),
    indices: r.u16ArrayAt(idx.offset, idx.count),
    submeshes,
    batches,
    boneCountMax,
  };
}
