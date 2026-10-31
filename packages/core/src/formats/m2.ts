import { BinaryReader } from "../io/BinaryReader.js";

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

export const M2GlobalFlags = {
	/** Adds the `textureCombinerCombos` array to the end of the header. */
	UseTextureCombinerCombos: 0x8,
} as const;

/** Texture combiner ops (EGxTexBlend). A batch's shader id names one per texture layer. */
export const M2Combiner = {
	Opaque: 0,
	Mod: 1,
	Decal: 2,
	Add: 3,
	Mod2x: 4,
	Fade: 5,
	Mod2xNa: 6,
	AddNa: 7,
	Envmap: 8,
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

export const M2LightType = {
	/** Not used outside the glue screens, where the client takes the direction from elsewhere. */
	Directional: 0,
	Point: 1,
} as const;

/**
 * A light carried by the model. The glue-screen backdrops light their moonwells and torches with
 * point lights like these; their directional entries repeat what `RaceLights` in the client's
 * GlueXML already says.
 */
export interface M2Light {
	/** See M2LightType. */
	type: number;
	/** Bone the position hangs off, -1 for none. */
	bone: number;
	/** Relative to `bone`. */
	position: [number, number, number];
	ambientColor: M2Track; // vec3
	ambientIntensity: M2Track; // float, 1 by default
	diffuseColor: M2Track; // vec3
	diffuseIntensity: M2Track; // float, 1 by default
	attenuationStart: M2Track; // float
	attenuationEnd: M2Track; // float
	visibility: M2Track; // uint8, on by default
}

/**
 * A camera baked into the model. The glue-screen backdrops carry exactly one, which is the view
 * their scene was composed for.
 */
export interface M2Camera {
	/** 0 portrait, 1 character info, -1 anything else (a backdrop's own view). */
	type: number;
	/** Diagonal field of view in radians; the client derives a vertical one from the aspect ratio. */
	fov: number;
	farClip: number;
	nearClip: number;
	/** Eye position. */
	position: [number, number, number];
	/** Point the camera looks at. */
	target: [number, number, number];
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
	/** Combiner op per texture layer, indexed by a batch's shader id; empty without the global flag. */
	textureCombinerCombos: Uint16Array;
	attachments: M2Attachment[];
	attachmentLookup: Int16Array;
	lights: M2Light[];
	cameras: M2Camera[];
	particleEmitters: M2ParticleEmitter[];
	/** Source bytes: embedded sequence data is read from here. */
	reader: BinaryReader;
}

/**
 * Keyframes over a particle's lifetime; `times` are 0..1 life fractions, `comp` floats per value.
 * Shaped like `TrackKeys` so the shared sampler can read it.
 */
export interface M2PartTrack {
	times: Float32Array;
	values: Float32Array;
	comp: number;
	/** Always linear. */
	interpolation: number;
}

export interface M2ParticleEmitter {
	id: number;
	flags: number;
	/** Emitter origin relative to `bone`. */
	position: [number, number, number];
	bone: number;
	/** Index into the M2 texture list. */
	texture: number;
	blendMode: number;
	/** 1 = plane, 2 = sphere, 3 = spline. */
	emitterType: number;
	particleColorIndex: number;
	particleType: number;
	headOrTail: number;
	priorityPlane: number;
	textureRows: number;
	textureCols: number;
	emissionSpeed: M2Track;
	speedVariation: M2Track;
	verticalRange: M2Track;
	horizontalRange: M2Track;
	gravity: M2Track;
	lifespan: M2Track;
	lifespanVary: number;
	emissionRate: M2Track;
	emissionRateVary: number;
	/** Plane: the rectangle's extent along the bone's Y. Sphere: the outer radius. */
	emissionAreaWidth: M2Track;
	/** Plane: the rectangle's extent along the bone's X. Sphere: the inner radius. */
	emissionAreaLength: M2Track;
	zSource: M2Track;
	alpha: M2PartTrack; // 1 comp
	color: M2PartTrack; // 3 comps, 0..255
	scale: M2PartTrack; // 2 comps
	scaleVary: [number, number];
	headCell: M2PartTrack; // 1 comp
	tailCell: M2PartTrack; // 1 comp
	tailLength: number;
	twinkleSpeed: number;
	twinklePercent: number;
	twinkleScale: [number, number];
	inheritVelocityScale: number;
	drag: number;
	baseSpin: number;
	baseSpinVary: number;
	spin: number;
	spinVary: number;
	tumbleMin: [number, number, number];
	tumbleMax: [number, number, number];
	windVector: [number, number, number];
	windTime: number;
	followSpeed1: number;
	followScale1: number;
	followSpeed2: number;
	followScale2: number;
	enabledIn: M2Track; // uint8
}

export const M2ParticleFlags = {
	/**
	 * Draw flat rather than lit by the scene. The client carries the bit inverted in the material it
	 * builds for the emitter, and then withholds the lighting a second time from a Mod or Mod2x blend
	 * — which only one emitter in the whole client asks for with the bit clear.
	 */
	Unlit: 0x1,
	/** Draw this emitter's own particles back to front. Every emitter asking is an Alpha blend. */
	SortParticles: 0x2,
	/** Billboard aligns along the velocity vector. */
	VelocityOrient: 0x4,
	Unfogged: 0x8,
	/**
	 * Simulated in the emitter's own frame, so the particles ride its bone and gravity pulls along
	 * that bone's -Z. Without it they are shed into the model's frame of reference at birth and left
	 * there. The client holds this as its own `0x200` and applies the emitter transform at draw time;
	 * the name is not "world space", which is what the flag being *clear* comes closest to.
	 */
	LocalFrame: 0x10,
	InheritBoneScale: 0x20,
	InheritVelocity: 0x40,
	/** Kills a particle once it moves away from the emitter. Sphere emitters only. */
	ImplosionFilter: 0x80,
	/** Sends a sphere's particles up its own Z rather than out along the radius. Sphere emitters only. */
	HemisphereUpDirection: 0x100,
	/** Half the particles spin the other way. */
	NegateSpinRandom: 0x200,
	/** Tail reaches back at most as far as the particle has lived. */
	ClampTailToAge: 0x400,
	InheritPosition: 0x800,
	XyQuad: 0x1000,
	ProjectParticle: 0x2000,
	FollowPosition: 0x4000,
	/** Emits only while the emission rate track is above zero. */
	Squirt: 0x8000,
	ChooseRandomTexture: 0x10000,
	/** Draw a camera-facing quad. */
	HeadStyle: 0x20000,
	/** Draw a quad stretched back along the direction of travel. */
	TailStyle: 0x40000,
	/** ScaleVary drives x and y independently rather than uniformly from x. */
	UnscaledSizeVariation: 0x80000,
	Refraction: 0x100000,
	RandFlipbookStart: 0x200000,
	CompressedGravity: 0x800000,
	BoneGeneratorBone: 0x1000000,
	NoGlobalViewScale: 0x2000000,
	LodIgnoreDistance: 0x4000000,
	OffsetHeadBySpin: 0x8000000,
	MultiTexture: 0x10000000,
} as const;

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

/** Reads a particle "FBlock": fixed16 life-fraction times plus values of `comp` components. */
function readPartTrack(r: BinaryReader, comp: number, kind: "fixed16" | "float" | "u16"): M2PartTrack {
	const ts = readArray(r);
	const vs = readArray(r);
	const times = new Float32Array(ts.count);
	for (let i = 0; i < ts.count; i++) times[i] = r.i16At(ts.offset + i * 2) / 32767;
	const n = vs.count * comp;
	let values: Float32Array;
	if (kind === "float") values = r.f32ArrayAt(vs.offset, n);
	else {
		values = new Float32Array(n);
		for (let i = 0; i < n; i++)
			values[i] = kind === "u16" ? r.u16At(vs.offset + i * 2) : r.i16At(vs.offset + i * 2) / 32767;
	}
	return { times, values, comp, interpolation: 1 };
}

// 476 bytes in version 264.
const readParticle = (r: BinaryReader): M2ParticleEmitter => {
	const id = r.u32();
	const flags = r.u32();
	const position = r.vec3();
	const bone = r.u16();
	const texture = r.u16();
	r.skip(16); // geometry / recursion model file names
	const blendMode = r.u8();
	const emitterType = r.u8();
	const particleColorIndex = r.u16();
	const particleType = r.u8();
	const headOrTail = r.u8();
	const priorityPlane = r.i16();
	const textureRows = r.u16();
	const textureCols = r.u16();
	const emissionSpeed = readTrack(r);
	const speedVariation = readTrack(r);
	const verticalRange = readTrack(r);
	const horizontalRange = readTrack(r);
	const gravity = readTrack(r);
	const lifespan = readTrack(r);
	const lifespanVary = r.f32();
	const emissionRate = readTrack(r);
	const emissionRateVary = r.f32();
	const emissionAreaWidth = readTrack(r);
	const emissionAreaLength = readTrack(r);
	const zSource = readTrack(r);
	const color = readPartTrack(r, 3, "float");
	const alpha = readPartTrack(r, 1, "fixed16");
	const scale = readPartTrack(r, 2, "float");
	const scaleVary: [number, number] = [r.f32(), r.f32()];
	const headCell = readPartTrack(r, 1, "u16");
	const tailCell = readPartTrack(r, 1, "u16");
	const tailLength = r.f32();
	const twinkleSpeed = r.f32();
	const twinklePercent = r.f32();
	const twinkleScale: [number, number] = [r.f32(), r.f32()];
	const inheritVelocityScale = r.f32();
	const drag = r.f32();
	const baseSpin = r.f32();
	const baseSpinVary = r.f32();
	const spin = r.f32();
	const spinVary = r.f32();
	const tumbleMin = r.vec3();
	const tumbleMax = r.vec3();
	const windVector = r.vec3();
	const windTime = r.f32();
	const followSpeed1 = r.f32();
	const followScale1 = r.f32();
	const followSpeed2 = r.f32();
	const followScale2 = r.f32();
	r.skip(8); // spline points
	const enabledIn = readTrack(r);
	return {
		id,
		flags,
		position,
		bone,
		texture,
		blendMode,
		emitterType,
		particleColorIndex,
		particleType,
		headOrTail,
		priorityPlane,
		textureRows,
		textureCols,
		emissionSpeed,
		speedVariation,
		verticalRange,
		horizontalRange,
		gravity,
		lifespan,
		lifespanVary,
		emissionRate,
		emissionRateVary,
		emissionAreaWidth,
		emissionAreaLength,
		zSource,
		alpha,
		color,
		scale,
		scaleVary,
		headCell,
		tailCell,
		tailLength,
		twinkleSpeed,
		twinklePercent,
		twinkleScale,
		inheritVelocityScale,
		drag,
		baseSpin,
		baseSpinVary,
		spin,
		spinVary,
		tumbleMin,
		tumbleMax,
		windVector,
		windTime,
		followSpeed1,
		followScale1,
		followSpeed2,
		followScale2,
		enabledIn,
	};
};

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

// 156 bytes (0x9C).
const readLight = (r: BinaryReader): M2Light => {
	const type = r.u16();
	const bone = r.i16();
	const position = r.vec3();
	const ambientColor = readTrack(r);
	const ambientIntensity = readTrack(r);
	const diffuseColor = readTrack(r);
	const diffuseIntensity = readTrack(r);
	const attenuationStart = readTrack(r);
	const attenuationEnd = readTrack(r);
	const visibility = readTrack(r);
	return {
		type,
		bone,
		position,
		ambientColor,
		ambientIntensity,
		diffuseColor,
		diffuseIntensity,
		attenuationStart,
		attenuationEnd,
		visibility,
	};
};

// 100 bytes up to Cataclysm, which moved `fov` to the end and made it a track.
const readCamera = (r: BinaryReader): M2Camera => {
	const type = r.i32();
	const fov = r.f32();
	const farClip = r.f32();
	const nearClip = r.f32();
	// Both tracks hold offsets from the base position that a still camera leaves at zero, so only
	// the bases are read; every backdrop's camera is still.
	readTrack(r);
	const position = r.vec3();
	readTrack(r);
	const target = r.vec3();
	return { type, fov, farClip, nearClip, position, target };
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
		v.positions[i * 3] = r.f32();
		v.positions[i * 3 + 1] = r.f32();
		v.positions[i * 3 + 2] = r.f32();
		for (let k = 0; k < 4; k++) v.boneWeights[i * 4 + k] = r.u8();
		for (let k = 0; k < 4; k++) v.boneIndices[i * 4 + k] = r.u8();
		v.normals[i * 3] = r.f32();
		v.normals[i * 3 + 1] = r.f32();
		v.normals[i * 3 + 2] = r.f32();
		v.uv0[i * 2] = r.f32();
		v.uv0[i * 2 + 1] = r.f32();
		v.uv1[i * 2] = r.f32();
		v.uv1[i * 2 + 1] = r.f32();
	}
	return v;
}

export function parseM2(buffer: ArrayBuffer): M2Data {
	const r = new BinaryReader(buffer);
	if (r.string(4) !== "MD20") throw new Error("Not an MD20 file");
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
	r.skip(8); // events: unused
	const lights = readArray(r);
	const cameras = readArray(r);
	r.skip(8 * 2); // camera lookup and ribbons: unused
	const particles = readArray(r);
	// Only present with the global flag, and always last, so nothing else shifts when it is absent.
	const combinerCombos =
		globalFlags & M2GlobalFlags.UseTextureCombinerCombos ? readArray(r) : { count: 0, offset: 0 };

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
			return { type, flags, filename: fn.count > 1 ? r.cstringAt(fn.offset) : "" };
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
		textureCombinerCombos: u16(combinerCombos),
		attachmentLookup: i16(attachmentLookup),
		lights: readList(r, lights, 156, readLight),
		cameras: readList(r, cameras, 100, readCamera),
		particleEmitters: readList(r, particles, 476, readParticle),
		reader: r,
	};
}
