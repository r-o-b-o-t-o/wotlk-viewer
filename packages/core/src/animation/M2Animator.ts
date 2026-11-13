import { Matrix4, Quaternion, Vector3 } from "three";
import { M2BoneFlags, type M2Bone, type M2Track } from "../formats/m2.js";
import type { M2Model } from "../render/M2Model.js";
import { sampleTrack, type TrackKeys, type TrackKind } from "./tracks.js";

const BILLBOARD_MASK =
	M2BoneFlags.SphericalBillboard |
	M2BoneFlags.CylindricalBillboardX |
	M2BoneFlags.CylindricalBillboardY |
	M2BoneFlags.CylindricalBillboardZ;

const tmpV = new Float32Array(4);
const tmpPos = new Vector3();
const tmpQuat = new Quaternion();
const tmpScale = new Vector3();
const tmpMat = new Matrix4();
const tmpPivot = new Matrix4();
const HALF = new Matrix4().makeTranslation(0.5, 0.5, 0);
const NEG_HALF = new Matrix4().makeTranslation(-0.5, -0.5, 0);

/** A light the model carries, evaluated at the current time. */
export interface AnimatedLight {
	/** Model space, its bone already applied. */
	position: Vector3;
	/** Diffuse colour scaled by the light's intensity; black while it is switched off. */
	color: Vector3;
}

/** Camera axes expressed in the model's local space, used for billboarded bones. */
export interface BillboardBasis {
	right: Vector3;
	up: Vector3;
	/** Points from the model towards the camera. */
	back: Vector3;
}

/** Evaluates one sequence of an M2 model: bone matrices, colors, transparencies, texture transforms. */
export class M2Animator {
	/** Final bone matrices in model space (bind pose -> animated). */
	readonly boneMatrices: Matrix4[];
	/** RGBA per M2 color entry. */
	readonly colors: Float32Array;
	/** Alpha per M2 texture weight entry. */
	readonly textureWeights: Float32Array;
	readonly textureMatrices: Matrix4[];
	/** One per `m2.lights`, in the same order, so the type of each is still there to read. */
	readonly lights: AnimatedLight[];

	/** Alias-resolved sequence index being played. */
	sequence = 0;
	/** Position in the sequence, ms. */
	time = 0;
	loop = true;
	playing = true;
	speed = 1;
	/** Wall-clock time driving global sequences, ms. */
	globalTime = 0;
	/** Called when a non-looping sequence reaches its end. */
	onFinished: (() => void) | null = null;

	private readonly localMatrices: Matrix4[];
	/** One flag per bone: those set are posed from `overrideSequence` instead. */
	private overrideBones: Uint8Array | null = null;
	private overrideSequence = 0;

	constructor(readonly model: M2Model) {
		const m2 = model.m2;
		this.boneMatrices = m2.bones.map(() => new Matrix4());
		this.localMatrices = m2.bones.map(() => new Matrix4());
		this.colors = new Float32Array(m2.colors.length * 4).fill(1);
		this.textureWeights = new Float32Array(m2.textureWeights.length).fill(1);
		this.textureMatrices = m2.textureTransforms.map(() => new Matrix4());
		this.lights = m2.lights.map(() => ({ position: new Vector3(), color: new Vector3() }));
	}

	get duration(): number {
		return this.model.m2.sequences[this.sequence]?.duration ?? 0;
	}

	play(sequence: number, loop = true): void {
		this.sequence = this.model.resolveAlias(sequence);
		this.time = 0;
		this.loop = loop;
		this.playing = true;
	}

	/** Back to the start of the current sequence, global sequences included. */
	rewind(): void {
		this.time = 0;
		this.globalTime = 0;
		this.playing = true;
	}

	/**
	 * Keeps the flagged bones on another sequence while the main one plays; the game grips weapons by
	 * posing the fingers from HandsClosed like this. `bones` holds one flag per bone, null to clear.
	 */
	setBoneOverride(sequence: number, bones: Uint8Array | null): void {
		this.overrideBones = bones;
		this.overrideSequence = this.model.resolveAlias(sequence);
	}

	/** Advances time by `dtMs` and re-evaluates every animated property. */
	update(dtMs: number, billboard?: BillboardBasis): void {
		this.globalTime += dtMs;
		if (this.playing) {
			this.time += dtMs * this.speed;
			const d = this.duration;
			if (this.time >= d) {
				if (this.loop) this.time = d > 0 ? this.time % d : 0;
				else {
					this.time = d;
					this.playing = false;
					this.onFinished?.();
				}
			}
		}
		this.evaluate(billboard);
	}

	/** Evaluates all tracks at the current time. */
	evaluate(billboard?: BillboardBasis): void {
		this.evaluateBones(billboard);
		this.evaluateColors();
		this.evaluateTextureTransforms();
		if (this.lights.length > 0) this.evaluateLights();
	}

	private trackTime(globalSeq: number): number {
		if (globalSeq < 0) return this.time;
		const d = this.model.m2.globalLoops[globalSeq];
		return d > 0 ? this.globalTime % d : 0;
	}

	private sample(keys: TrackKeys | null, globalSeq: number, out: Float32Array, isQuat = false): boolean {
		if (!keys) return false;
		sampleTrack(keys, this.trackTime(globalSeq), out, isQuat);
		return true;
	}

	/** Samples a scalar track at the current time; `fallback` when it has no data. */
	sampleScalar(track: M2Track, kind: TrackKind, fallback: number): number {
		return this.sample(this.model.keys(track, this.sequence, kind), track.globalSeq, tmpV) ? tmpV[0] : fallback;
	}

	/** Samples a vec3 track into the first three slots of `out`; false when it has no data. */
	sampleVec3(track: M2Track, out: Float32Array): boolean {
		return this.sample(this.model.keys(track, this.sequence, "vec3"), track.globalSeq, out);
	}

	/**
	 * A bone's rotation keys, dropping a lone key that turns the model's own root bone outside a
	 * global sequence. Those four are export leftovers that face a shoulder pad backwards; keys on
	 * any other bone are real posing, the two that lay Frostmourne's glow along its blade among
	 * them. README has the tally.
	 */
	private boneRotationKeys(bone: M2Bone, index: number, seq: number): TrackKeys | null {
		const track = bone.rotation;
		const lone = track.timestamps.length === 1 && track.timestamps[0].count === 1;
		if (lone && index === 0 && bone.parentBone < 0 && track.globalSeq < 0) return null;
		return this.model.keys(track, seq, "compquat");
	}

	private evaluateBones(billboard?: BillboardBasis): void {
		const { m2 } = this.model;
		for (let i = 0; i < m2.bones.length; i++) {
			const seq = this.overrideBones?.[i] ? this.overrideSequence : this.sequence;
			const bone = m2.bones[i];
			const local = this.localMatrices[i];
			const tKeys = this.model.keys(bone.translation, seq, "vec3");
			const rKeys = this.boneRotationKeys(bone, i, seq);
			const sKeys = this.model.keys(bone.scale, seq, "vec3");
			const [px, py, pz] = bone.pivot;

			if (!tKeys && !rKeys && !sKeys && !(bone.flags & BILLBOARD_MASK)) {
				local.identity();
			} else {
				tmpPos.set(px, py, pz);
				if (this.sample(tKeys, bone.translation.globalSeq, tmpV))
					((tmpPos.x += tmpV[0]), (tmpPos.y += tmpV[1]), (tmpPos.z += tmpV[2]));
				if (this.sample(rKeys, bone.rotation.globalSeq, tmpV, true))
					tmpQuat.set(tmpV[0], tmpV[1], tmpV[2], tmpV[3]);
				else tmpQuat.identity();
				if (this.sample(sKeys, bone.scale.globalSeq, tmpV)) tmpScale.set(tmpV[0], tmpV[1], tmpV[2]);
				else tmpScale.set(1, 1, 1);
				// T(pivot + translation) * R * S * T(-pivot)
				local.compose(tmpPos, tmpQuat, tmpScale).multiply(tmpPivot.makeTranslation(-px, -py, -pz));
			}

			const world = this.boneMatrices[i];
			if (bone.parentBone >= 0) world.multiplyMatrices(this.boneMatrices[bone.parentBone], local);
			else world.copy(local);

			if (billboard && bone.flags & BILLBOARD_MASK) applyBillboard(world, bone.pivot, billboard, bone.flags);
		}
	}

	private evaluateColors(): void {
		const { m2 } = this.model;
		const seq = this.sequence;
		for (let i = 0; i < m2.colors.length; i++) {
			const c = m2.colors[i];
			const o = i * 4;
			if (this.sample(this.model.keys(c.color, seq, "vec3"), c.color.globalSeq, tmpV)) {
				this.colors[o] = tmpV[0];
				this.colors[o + 1] = tmpV[1];
				this.colors[o + 2] = tmpV[2];
			} else this.colors[o] = this.colors[o + 1] = this.colors[o + 2] = 1;
			this.colors[o + 3] = this.sample(this.model.keys(c.alpha, seq, "fixed16"), c.alpha.globalSeq, tmpV)
				? tmpV[0]
				: 1;
		}
		for (let i = 0; i < m2.textureWeights.length; i++) {
			const w = m2.textureWeights[i].weight;
			this.textureWeights[i] = this.sample(this.model.keys(w, seq, "fixed16"), w.globalSeq, tmpV) ? tmpV[0] : 1;
		}
	}

	/** Only the diffuse side: every light in the client that carries an ambient term is a backdrop's
	 *  directional one, which the glue screen takes from its own table instead. */
	private evaluateLights(): void {
		const { m2 } = this.model;
		for (let i = 0; i < m2.lights.length; i++) {
			const light = m2.lights[i];
			const out = this.lights[i];
			out.position.fromArray(light.position);
			// A light hangs off a bone, and -1 means it hangs off the model itself.
			const bone = this.boneMatrices[light.bone];
			if (bone) out.position.applyMatrix4(bone);
			if (
				this.sample(
					this.model.keys(light.diffuseColor, this.sequence, "vec3"),
					light.diffuseColor.globalSeq,
					tmpV,
				)
			)
				out.color.set(tmpV[0], tmpV[1], tmpV[2]);
			else out.color.set(1, 1, 1);
			const on = this.sampleScalar(light.visibility, "u8", 1) > 0;
			out.color.multiplyScalar(on ? this.sampleScalar(light.diffuseIntensity, "float", 1) : 0);
		}
	}

	private evaluateTextureTransforms(): void {
		const { m2 } = this.model;
		const seq = this.sequence;
		for (let i = 0; i < m2.textureTransforms.length; i++) {
			const tt = m2.textureTransforms[i];
			if (this.sample(this.model.keys(tt.translation, seq, "vec3"), tt.translation.globalSeq, tmpV))
				tmpPos.set(tmpV[0], tmpV[1], tmpV[2]);
			else tmpPos.set(0, 0, 0);
			if (this.sample(this.model.keys(tt.rotation, seq, "quat"), tt.rotation.globalSeq, tmpV, true))
				tmpQuat.set(tmpV[0], tmpV[1], tmpV[2], tmpV[3]);
			else tmpQuat.identity();
			if (this.sample(this.model.keys(tt.scaling, seq, "vec3"), tt.scaling.globalSeq, tmpV))
				tmpScale.set(tmpV[0], tmpV[1], tmpV[2]);
			else tmpScale.set(1, 1, 1);
			// Transforms are applied around the UV centre.
			this.textureMatrices[i]
				.copy(HALF)
				.multiply(tmpMat.compose(tmpPos, tmpQuat, tmpScale))
				.multiply(NEG_HALF);
		}
	}
}

const bbX = new Vector3(),
	bbY = new Vector3(),
	bbZ = new Vector3(),
	bbPivot = new Vector3();

/**
 * `axis` crossed with the direction towards the camera, normalized: the one axis of a cylindrical
 * billboard that the client works out, the third being a cross of the two. Looking straight down the
 * locked axis leaves no such direction, so the camera's up stands in rather than leaving a zero row.
 */
function acrossView(out: Vector3, axis: Vector3, basis: BillboardBasis): Vector3 {
	out.crossVectors(axis, basis.back);
	if (out.lengthSq() < 1e-12) out.crossVectors(axis, basis.up);
	return out.normalize();
}

/**
 * Re-orients a billboarded bone (scale and pivot position are kept). Spherical: X faces the camera,
 * Y = camera right, Z = camera up, matching WoW's X-forward / Z-up bone space.
 *
 * A cylindrical variant keeps its locked axis and turns the other two around it, as `AnimateBones`
 * does: first the axis across the view, the locked one crossed with the view direction, then a cross
 * of those two for the third, which lands along the view. So a lock on X or Y turns the bone's Z to
 * the camera, and a lock on Z turns X the way the spherical case does. The way that axis points is
 * the client's too, and settles which face of a one-sided batch is seen: away from the camera for a
 * lock on X or Y, towards it for a lock on Z.
 */
function applyBillboard(world: Matrix4, pivot: [number, number, number], basis: BillboardBasis, flags: number): void {
	const e = world.elements;
	const sx = Math.hypot(e[0], e[1], e[2]);
	const sy = Math.hypot(e[4], e[5], e[6]);
	const sz = Math.hypot(e[8], e[9], e[10]);
	// World position of the pivot must stay put: p' = R' * pivot + t'  =>  t' = p - R' * pivot
	bbPivot.set(pivot[0], pivot[1], pivot[2]).applyMatrix4(world);
	if (flags & M2BoneFlags.CylindricalBillboardZ) {
		bbZ.set(e[8], e[9], e[10]).normalize();
		acrossView(bbY, bbZ, basis);
		bbX.crossVectors(bbY, bbZ);
	} else if (flags & M2BoneFlags.CylindricalBillboardX) {
		bbX.set(e[0], e[1], e[2]).normalize();
		acrossView(bbY, bbX, basis);
		bbZ.crossVectors(bbX, bbY);
	} else if (flags & M2BoneFlags.CylindricalBillboardY) {
		bbY.set(e[4], e[5], e[6]).normalize();
		// Alone among the three, the client crosses this pair the other way round; hence the flip.
		acrossView(bbX, bbY, basis).negate();
		bbZ.crossVectors(bbX, bbY);
	} else {
		bbX.copy(basis.back);
		bbY.copy(basis.right);
		bbZ.copy(basis.up);
	}
	bbX.multiplyScalar(sx);
	bbY.multiplyScalar(sy);
	bbZ.multiplyScalar(sz);
	e[0] = bbX.x;
	e[1] = bbX.y;
	e[2] = bbX.z;
	e[4] = bbY.x;
	e[5] = bbY.y;
	e[6] = bbY.z;
	e[8] = bbZ.x;
	e[9] = bbZ.y;
	e[10] = bbZ.z;
	e[12] = bbPivot.x - (bbX.x * pivot[0] + bbY.x * pivot[1] + bbZ.x * pivot[2]);
	e[13] = bbPivot.y - (bbX.y * pivot[0] + bbY.y * pivot[1] + bbZ.y * pivot[2]);
	e[14] = bbPivot.z - (bbX.z * pivot[0] + bbY.z * pivot[1] + bbZ.z * pivot[2]);
}
