import { BinaryReader } from '../io/BinaryReader';

/** M2 (version 264, WotLK) model data. Only the parts needed for rendering are parsed. */

export interface M2Array {
  count: number;
  offset: number;
}

/** Animation track. `timestamps[i]`/`values[i]` describe the data of sequence i. */
export interface M2Track {
  interpolation: number; // 0 none, 1 linear, 2 hermite, 3 bezier
  globalSeq: number; // -1 = none
  timestamps: M2Array[];
  values: M2Array[];
}

export interface M2Sequence {
  id: number;
  variationIndex: number;
  duration: number;
  moveSpeed: number;
  flags: number;
  frequency: number;
  blendTime: number;
  variationNext: number;
  aliasNext: number;
}

export const M2SequenceFlags = {
  /** Sequence data lives in the .m2 rather than an external .anim file. */
  Embedded: 0x20,
  /** Sequence aliases `aliasNext`. */
  Alias: 0x40,
} as const;

export interface M2Bone {
  keyBoneId: number;
  flags: number;
  parentBone: number;
  submeshId: number;
  translation: M2Track;
  rotation: M2Track;
  scale: M2Track;
  pivot: [number, number, number];
}

export const M2BoneFlags = {
  SphericalBillboard: 0x8,
  CylindricalBillboardX: 0x10,
  CylindricalBillboardY: 0x20,
  CylindricalBillboardZ: 0x40,
  Transformed: 0x200,
} as const;

export interface M2Vertices {
  count: number;
  positions: Float32Array; // xyz
  boneWeights: Uint8Array; // 4 per vertex
  boneIndices: Uint8Array; // 4 per vertex
  normals: Float32Array; // xyz
  uv0: Float32Array;
  uv1: Float32Array;
}

export interface M2Color {
  color: M2Track; // vec3
  alpha: M2Track; // fixed16
}

export interface M2TextureWeight {
  weight: M2Track; // fixed16
}

export interface M2TextureTransform {
  translation: M2Track; // vec3
  rotation: M2Track; // quat (float)
  scaling: M2Track; // vec3
}

export interface M2Texture {
  /** 0 = hardcoded `filename`, otherwise a replaceable slot (see M2TextureType). */
  type: number;
  flags: number; // 1 wrap X, 2 wrap Y
  filename: string;
}

export const M2TextureType = {
  Hardcoded: 0,
  Skin: 1,
  ObjectSkin: 2,
  WeaponBlade: 3,
  WeaponHandle: 4,
  Environment: 5,
  Hair: 6,
  FacialHair: 7,
  SkinExtra: 8,
  UiSkin: 9,
  TaurenMane: 10,
  Monster1: 11,
  Monster2: 12,
  Monster3: 13,
  ItemIcon: 14,
} as const;

export interface M2Material {
  flags: number;
  blendMode: number;
}

export const M2MaterialFlags = {
  Unlit: 0x1,
  Unfogged: 0x2,
  TwoSided: 0x4,
  DepthTestOff: 0x8,
  DepthWriteOff: 0x10,
} as const;

export const M2BlendMode = {
  Opaque: 0,
  AlphaKey: 1,
  Alpha: 2,
  NoAlphaAdd: 3,
  Add: 4,
  Mod: 5,
  Mod2x: 6,
  BlendAdd: 7,
} as const;

export interface M2Attachment {
  id: number;
  bone: number;
  position: [number, number, number];
  animateAttached: M2Track; // uint8
}

export interface M2Data {
  name: string;
  globalFlags: number;
  globalLoops: Uint32Array; // durations in ms
  sequences: M2Sequence[];
  sequenceLookup: Int16Array; // animation id -> sequence index (-1 = none)
  bones: M2Bone[];
  keyBoneLookup: Int16Array;
  vertices: M2Vertices;
  skinProfileCount: number;
  colors: M2Color[];
  textures: M2Texture[];
  textureWeights: M2TextureWeight[];
  textureTransforms: M2TextureTransform[];
  replaceableTextureLookup: Int16Array;
  materials: M2Material[];
  boneLookup: Uint16Array;
  textureLookup: Uint16Array;
  textureUnitLookup: Int16Array;
  transparencyLookup: Int16Array;
  textureTransformLookup: Int16Array;
  boundingBox: { min: [number, number, number]; max: [number, number, number] };
  boundingSphereRadius: number;
  attachments: M2Attachment[];
  attachmentLookup: Int16Array;
  /** Source bytes: embedded sequence data is read from here. */
  reader: BinaryReader;
}

const readArray = (r: BinaryReader): M2Array => ({ count: r.u32(), offset: r.u32() });

function readTrack(r: BinaryReader): M2Track {
  const interpolation = r.u16();
  const globalSeq = r.i16();
  const ts = readArray(r);
  const vs = readArray(r);
  return {
    interpolation,
    globalSeq,
    timestamps: readArrayOfArrays(r, ts),
    values: readArrayOfArrays(r, vs),
  };
}

function readArrayOfArrays(r: BinaryReader, a: M2Array): M2Array[] {
  const out: M2Array[] = new Array(a.count);
  for (let i = 0; i < a.count; i++) {
    out[i] = { count: r.u32At(a.offset + i * 8), offset: r.u32At(a.offset + i * 8 + 4) };
  }
  return out;
}

function readList<T>(r: BinaryReader, a: M2Array, size: number, read: (r: BinaryReader) => T): T[] {
  const out: T[] = new Array(a.count);
  for (let i = 0; i < a.count; i++) {
    r.seek(a.offset + i * size);
    out[i] = read(r);
  }
  return out;
}

const readSequence = (r: BinaryReader): M2Sequence => {
  const id = r.u16();
  const variationIndex = r.u16();
  const duration = r.u32();
  const moveSpeed = r.f32();
  const flags = r.u32();
  const frequency = r.i16();
  r.skip(2 + 8); // padding, replay range
  const blendTime = r.u32();
  r.skip(28); // bounds
  const variationNext = r.i16();
  const aliasNext = r.u16();
  return { id, variationIndex, duration, moveSpeed, flags, frequency, blendTime, variationNext, aliasNext };
};

const readBone = (r: BinaryReader): M2Bone => {
  const keyBoneId = r.i32();
  const flags = r.u32();
  const parentBone = r.i16();
  const submeshId = r.u16();
  r.skip(4); // bone name CRC / unknown
  const translation = readTrack(r);
  const rotation = readTrack(r);
  const scale = readTrack(r);
  const pivot = r.vec3();
  return { keyBoneId, flags, parentBone, submeshId, translation, rotation, scale, pivot };
};

function readVertices(r: BinaryReader, a: M2Array): M2Vertices {
  const n = a.count;
  const v: M2Vertices = {
    count: n,
    positions: new Float32Array(n * 3),
    boneWeights: new Uint8Array(n * 4),
    boneIndices: new Uint8Array(n * 4),
    normals: new Float32Array(n * 3),
    uv0: new Float32Array(n * 2),
    uv1: new Float32Array(n * 2),
  };
  for (let i = 0; i < n; i++) {
    r.seek(a.offset + i * 48);
    v.positions[i * 3] = r.f32(); v.positions[i * 3 + 1] = r.f32(); v.positions[i * 3 + 2] = r.f32();
    for (let k = 0; k < 4; k++) v.boneWeights[i * 4 + k] = r.u8();
    for (let k = 0; k < 4; k++) v.boneIndices[i * 4 + k] = r.u8();
    v.normals[i * 3] = r.f32(); v.normals[i * 3 + 1] = r.f32(); v.normals[i * 3 + 2] = r.f32();
    v.uv0[i * 2] = r.f32(); v.uv0[i * 2 + 1] = r.f32();
    v.uv1[i * 2] = r.f32(); v.uv1[i * 2 + 1] = r.f32();
  }
  return v;
}

export function parseM2(buffer: ArrayBuffer): M2Data {
  const r = new BinaryReader(buffer);
  if (r.string(4) !== 'MD20') throw new Error('Not an MD20 file');
  const version = r.u32();
  if (version !== 264) throw new Error(`Unsupported M2 version ${version} (expected 264)`);

  const name = readArray(r);
  const globalFlags = r.u32();
  const globalLoops = readArray(r);
  const sequences = readArray(r);
  const sequenceLookup = readArray(r);
  const bones = readArray(r);
  const keyBoneLookup = readArray(r);
  const vertices = readArray(r);
  const skinProfileCount = r.u32();
  const colors = readArray(r);
  const textures = readArray(r);
  const textureWeights = readArray(r);
  const textureTransforms = readArray(r);
  const replaceableTextureLookup = readArray(r);
  const materials = readArray(r);
  const boneLookup = readArray(r);
  const textureLookup = readArray(r);
  const textureUnitLookup = readArray(r);
  const transparencyLookup = readArray(r);
  const textureTransformLookup = readArray(r);
  const bbMin = r.vec3();
  const bbMax = r.vec3();
  const boundingSphereRadius = r.f32();
  r.skip(24 + 4 + 8 * 3); // collision box, radius, collision arrays
  const attachments = readArray(r);
  const attachmentLookup = readArray(r);
  // events, lights, cameras, camera lookup, ribbons, particles: unused

  const i16 = (a: M2Array) => r.i16ArrayAt(a.offset, a.count);
  const u16 = (a: M2Array) => r.u16ArrayAt(a.offset, a.count);

  return {
    name: r.cstringAt(name.offset),
    globalFlags,
    globalLoops: r.u32ArrayAt(globalLoops.offset, globalLoops.count),
    sequences: readList(r, sequences, 64, readSequence),
    sequenceLookup: i16(sequenceLookup),
    bones: readList(r, bones, 88, readBone),
    keyBoneLookup: i16(keyBoneLookup),
    vertices: readVertices(r, vertices),
    skinProfileCount,
    colors: readList(r, colors, 40, (r) => ({ color: readTrack(r), alpha: readTrack(r) })),
    textures: readList(r, textures, 16, (r) => {
      const type = r.u32();
      const flags = r.u32();
      const fn = readArray(r);
      return { type, flags, filename: fn.count > 1 ? r.cstringAt(fn.offset) : '' };
    }),
    textureWeights: readList(r, textureWeights, 20, (r) => ({ weight: readTrack(r) })),
    textureTransforms: readList(r, textureTransforms, 60, (r) => ({
      translation: readTrack(r),
      rotation: readTrack(r),
      scaling: readTrack(r),
    })),
    replaceableTextureLookup: i16(replaceableTextureLookup),
    materials: readList(r, materials, 4, (r) => ({ flags: r.u16(), blendMode: r.u16() })),
    boneLookup: u16(boneLookup),
    textureLookup: u16(textureLookup),
    textureUnitLookup: i16(textureUnitLookup),
    transparencyLookup: i16(transparencyLookup),
    textureTransformLookup: i16(textureTransformLookup),
    boundingBox: { min: bbMin, max: bbMax },
    boundingSphereRadius,
    attachments: readList(r, attachments, 40, (r) => {
      const id = r.u32();
      const bone = r.u16();
      r.skip(2);
      const position = r.vec3();
      return { id, bone, position, animateAttached: readTrack(r) };
    }),
    attachmentLookup: i16(attachmentLookup),
    reader: r,
  };
}
