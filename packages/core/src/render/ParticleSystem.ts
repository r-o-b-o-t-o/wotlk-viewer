import {
	BufferAttribute,
	BufferGeometry,
	DoubleSide,
	DynamicDrawUsage,
	Matrix4,
	Mesh,
	ShaderMaterial,
	Texture,
	Vector3,
} from "three";
import type { M2Animator, BillboardBasis } from "../animation/M2Animator.js";
import { M2ParticleFlags, type M2ParticleEmitter, type M2PartTrack } from "../formats/m2.js";
import { sampleTrack } from "../animation/tracks.js";
import { alphaTestFor, applyM2BlendMode } from "./M2Material.js";

const VERTEX = /* glsl */ `
attribute vec4 aColor;
varying vec2 vUv;
varying vec4 vColor;
void main() {
  vUv = uv;
  vColor = aColor;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const FRAGMENT = /* glsl */ `
uniform sampler2D uTex;
uniform float uAlphaTest;
varying vec2 vUv;
varying vec4 vColor;
void main() {
  vec4 c = texture2D(uTex, vUv) * vColor;
  if (c.a < uAlphaTest) discard;
  gl_FragColor = c;
}
`;

// Particle state layout: x y z vx vy vz age life cell scaleMul spin spinRate twinkle
// (cell < 0 = follow the head cell track; spin is the angle at birth, in radians; twinkle is the
// particle's own offset into TWINKLE_TABLE, standing in for the slot the client indexes by)
const STRIDE = 13;
// Quad corners as (right, up, cellU, cellV): (-r,+u) (+r,+u) (+r,-u) (-r,-u).
const CORNERS = new Int8Array([-1, 1, 0, 0, 1, 1, 1, 0, 1, -1, 1, 1, -1, -1, 0, 1]);
const tmpV = new Float32Array(4);
/** Fallback key times for a colour override when the emitter's own track is not start/middle/end. */
const DEFAULT_COLOR_TIMES = new Float32Array([0, 0.5, 1]);
const tmpPos = new Vector3();
const tmpDir = new Vector3();
const tmpAcross = new Vector3();
const tmpAlong = new Vector3();
const tmpMat = new Matrix4();
/** Camera axes re-expressed in a local-frame emitter's own space; rebuilt per emitter per frame. */
const tmpBasis: BillboardBasis = { right: new Vector3(), up: new Vector3(), back: new Vector3() };
/** Gravity for an emitter simulating in its own frame: that frame's -Z, which is what the client pulls along. */
const LOCAL_DOWN = new Vector3(0, 0, -1);
/**
 * The 128 uniform values a twinkle index looks up. The client fills its own table from `rand()` at
 * startup, so even its own runs disagree on the numbers; any fixed uniform set is as faithful, and
 * generating ours keeps a given particle's flicker the same from one run to the next.
 */
const TWINKLE_TABLE = /* @__PURE__ */ (() => {
	const table = new Float32Array(128);
	let state = 0x9e3779b9;
	for (let i = 0; i < table.length; i++) {
		state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
		table[i] = state / 0x100000000;
	}
	return table;
})();

/**
 * The frames an instance offers its emitters each frame. Which one an emitter picks is its own
 * choice, from `M2ParticleFlags.LocalFrame`.
 */
export interface EmitterFrames {
	/** Camera axes in the instance's own space. */
	local: BillboardBasis;
	/** Camera axes in the scene's space. */
	scene: BillboardBasis;
	/** The instance's world matrix. */
	world: Matrix4;
	/** Its inverse, which brings the scene back into the instance. */
	worldInverse: Matrix4;
	/** The instance's uniform world scale, which turns its own units into the scene's. */
	worldScale: number;
	/** Down in the scene, which gravity follows for particles shed into it. */
	sceneDown: Vector3;
}

/** Samples a life-fraction keyed track, falling back to a constant when it has no keys. */
function samplePart(track: M2PartTrack, t: number, out: Float32Array, fallback: number): void {
	if (track.times.length === 0) {
		out.fill(fallback, 0, track.comp);
		return;
	}
	sampleTrack(track, t, out);
}

/**
 * CPU-simulated M2 particle emitter rendered as camera-facing quads.
 *
 * Particles are simulated in one of two frames, as the client does. A `LocalFrame` emitter keeps
 * them in the emitter's own frame and lets the mesh carry that frame, so they ride the bone and
 * gravity pulls along the bone's -Z; every other emitter sheds them into the scene at birth and
 * leaves them there, falling along scene down.
 *
 * Simplified: no tumble, wind, zSource or spline emitters, and see "Known limitations" in the
 * README for the rest.
 */
export class ParticleSystem {
	readonly mesh: Mesh;
	private readonly material: ShaderMaterial;
	private readonly geometry: BufferGeometry;
	private readonly positions: Float32Array;
	private readonly uvs: Float32Array;
	private readonly colors: Float32Array;
	private readonly particles: Float32Array;
	/** position, uv and aColor, kept for per-frame partial uploads. */
	private readonly attributes: BufferAttribute[];
	private count = 0;
	private emitAccumulator = 0;
	/** Colour keys in use: the emitter's own, or a ParticleColor.dbc override. */
	private color: M2PartTrack;
	/** Which quad styles this emitter draws, and how many that is per particle. */
	private readonly head: boolean;
	private readonly tail: boolean;
	private readonly quadsPer: number;
	/** Simulate in the emitter's own frame rather than shedding into the scene. */
	private readonly localFrame: boolean;
	/** Fire one burst per rising edge of the rate track instead of streaming. */
	private readonly squirt: boolean;
	/** Whether the edge has already fired, so it takes a quiet frame to arm again. */
	private burstFired = false;
	/**
	 * How many particles this emitter may hold at once. The client allocates a pool from the emitter's
	 * own numbers whenever it is about to emit, grows it as those numbers rise and never shrinks it
	 * again, and emits nothing more while it is full; `maxParticles` is only the ceiling over that.
	 */
	private capacity = 0;
	/** The emitter's own frame: its bone, offset to the emitter's origin. */
	private readonly emitterFrame = new Matrix4();
	/** Emitter frame -> simulation space, applied to a particle once, at birth. */
	private readonly toSim = new Matrix4();
	/**
	 * Model units -> simulation space, for the sprite sizes. The scale track is in model units, which
	 * the mesh's own matrix carries for a local-frame emitter but not for one drawn in the scene.
	 */
	private sizeScale = 1;
	/** Hands each particle its own offset into TWINKLE_TABLE, the way the client's slots do. */
	private twinkleCounter = 0;
	/**
	 * Twinkle both resizes a particle and drops it for a frame at a time, from one index into
	 * TWINKLE_TABLE. The index only moves when one of the two can do anything, matching the client:
	 * a `twinkleScale` of (1, 1) and a `twinklePercent` of 1 leave it at zero, and the scale a plain 1.
	 * The range runs min to max, so an emitter writing them the other way round gets a negative span,
	 * which the client takes as readily.
	 */
	private readonly twinkleBase: number;
	private readonly twinkleSpan: number;
	private readonly twinkleOnOff: number;
	private readonly twinkles: boolean;

	constructor(
		readonly emitter: M2ParticleEmitter,
		texture: Texture,
		readonly maxParticles = 512,
	) {
		// Head and tail are independent styles; an emitter asking for both draws two quads per particle.
		// Neither bit set is treated as a head, which is what the client falls back to.
		this.tail = (emitter.flags & M2ParticleFlags.TailStyle) !== 0;
		this.head = !this.tail || (emitter.flags & M2ParticleFlags.HeadStyle) !== 0;
		this.quadsPer = (this.head ? 1 : 0) + (this.tail ? 1 : 0);
		this.localFrame = (emitter.flags & M2ParticleFlags.LocalFrame) !== 0;
		this.squirt = (emitter.flags & M2ParticleFlags.Squirt) !== 0;
		this.twinkleBase = emitter.twinkleScale[0];
		this.twinkleSpan = emitter.twinkleScale[1] - this.twinkleBase;
		this.twinkleOnOff = emitter.twinklePercent;
		this.twinkles = this.twinkleOnOff < 1 || this.twinkleSpan !== 0;
		const quads = maxParticles * this.quadsPer;
		this.particles = new Float32Array(maxParticles * STRIDE);
		this.positions = new Float32Array(quads * 4 * 3);
		this.uvs = new Float32Array(quads * 4 * 2);
		this.colors = new Float32Array(quads * 4 * 4);
		const index = new Uint16Array(quads * 6);
		for (let i = 0; i < quads; i++) {
			const v = i * 4;
			index.set([v, v + 1, v + 2, v, v + 2, v + 3], i * 6);
		}
		this.geometry = new BufferGeometry();
		this.geometry.setAttribute("position", new BufferAttribute(this.positions, 3).setUsage(DynamicDrawUsage));
		this.geometry.setAttribute("uv", new BufferAttribute(this.uvs, 2).setUsage(DynamicDrawUsage));
		this.geometry.setAttribute("aColor", new BufferAttribute(this.colors, 4).setUsage(DynamicDrawUsage));
		this.geometry.setIndex(new BufferAttribute(index, 1));
		this.geometry.setDrawRange(0, 0);
		this.attributes = ["position", "uv", "aColor"].map((n) => this.geometry.attributes[n] as BufferAttribute);

		this.material = new ShaderMaterial({
			vertexShader: VERTEX,
			fragmentShader: FRAGMENT,
			uniforms: { uTex: { value: texture }, uAlphaTest: { value: alphaTestFor(emitter.blendMode) } },
			depthWrite: false,
			side: DoubleSide,
		});
		applyM2BlendMode(this.material, emitter.blendMode);
		this.material.transparent = true; // always drawn after opaque geometry

		this.mesh = new Mesh(this.geometry, this.material);
		this.mesh.frustumCulled = false;
		// `update` writes the matrix that carries the simulation space, so three.js must not rebuild it.
		this.mesh.matrixAutoUpdate = false;
		this.color = emitter.color;
	}

	/**
	 * Replaces the colour keys with a ParticleColor.dbc triple, as start, middle and end RGB in 0..255.
	 * The emitter keeps its own key times and its alpha track. Pass null to go back to its own colours.
	 */
	setColorOverride(rgb: Float32Array | null): void {
		if (!rgb) {
			this.color = this.emitter.color;
			return;
		}
		const own = this.emitter.color;
		const times = own.times.length === 3 ? own.times : DEFAULT_COLOR_TIMES;
		this.color = { times, values: rgb, comp: 3, interpolation: 1 };
	}

	setTexture(texture: Texture): void {
		this.material.uniforms.uTex.value = texture;
	}

	/**
	 * Simulates `dt` seconds and rebuilds the quads. `bone` is the emitter bone's model-space matrix;
	 * `frames` carries the instance's own frame and the scene's, one of which this emitter simulates in.
	 */
	update(dt: number, animator: M2Animator, bone: Matrix4, frames: EmitterFrames): void {
		const e = this.emitter;
		const p = this.particles;

		this.emitterFrame.copy(bone).multiply(tmpMat.makeTranslation(e.position[0], e.position[1], e.position[2]));

		// A local-frame emitter simulates in its own frame and hands that frame to the mesh, so the
		// particles ride the bone however it moves. Everything else is baked into the scene at birth,
		// which is where the client's frame of reference leaves it for a character standing still.
		let basis: BillboardBasis;
		let down: Vector3;
		if (this.localFrame) {
			this.toSim.identity();
			this.mesh.matrix.copy(this.emitterFrame);
			basis = basisIn(this.emitterFrame, frames.local);
			down = LOCAL_DOWN;
			this.sizeScale = 1;
		} else {
			this.toSim.multiplyMatrices(frames.world, this.emitterFrame);
			this.mesh.matrix.copy(frames.worldInverse);
			basis = frames.scene;
			down = frames.sceneDown;
			this.sizeScale = frames.worldScale;
		}
		// The mesh's matrix is set after the viewer walked the graph, so ask for one more composition.
		this.mesh.matrixWorldNeedsUpdate = true;

		const g = animator.sampleScalar(e.gravity, "float", 0) * dt;
		const gx = down.x * g;
		const gy = down.y * g;
		const gz = down.z * g;
		const drag = Math.max(0, 1 - e.drag * dt);
		for (let i = 0; i < this.count;) {
			const o = i * STRIDE;
			p[o + 6] += dt;
			if (p[o + 6] >= p[o + 7]) {
				this.count--;
				p.copyWithin(o, this.count * STRIDE, this.count * STRIDE + STRIDE);
				continue;
			}
			p[o + 3] = (p[o + 3] + gx) * drag;
			p[o + 4] = (p[o + 4] + gy) * drag;
			p[o + 5] = (p[o + 5] + gz) * drag;
			p[o] += p[o + 3] * dt;
			p[o + 1] += p[o + 4] * dt;
			p[o + 2] += p[o + 5] * dt;
			i++;
		}

		// Spawn new ones.
		const visible = animator.sampleScalar(e.enabledIn, "u8", 1) !== 0;
		const tracked = animator.sampleScalar(e.emissionRate, "float", 0);
		const lifespan = animator.sampleScalar(e.lifespan, "float", 1);
		if (this.squirt) {
			// A squirt emitter never streams: the client leaves its "emitting" bit clear for good and
			// instead fires a single burst of `rate` particles each time the rate track rises above zero
			// while the emitter is visible, then waits for that edge to come round again. 597 of the 630
			// squirt emitters animate that track, so the burst lands once per cycle of the animation.
			// A burst of fewer than zero is held at none, where the client counts down past it and
			// empties its free list in one frame.
			const armed = visible && tracked > 0;
			if (armed && !this.burstFired) {
				this.grow(lifespan, tracked);
				const burst = Math.max(0, Math.floor(tracked + e.emissionRateVary * rand2()));
				for (let i = 0; i < burst && this.count < this.capacity; i++) this.spawn(animator, lifespan);
			}
			this.burstFired = armed;
		} else if (visible) {
			// The variation is a count per second to add, not a fraction to scale by, so it can pull the
			// rate below zero, and the client lets that drain the accumulator — throttling the emitter
			// until it climbs back, which is what keeps its average the rate the track asks for.
			//
			// The debt is held to a single particle. Without a floor it is a random walk, and the 23
			// emitters that pair a variation with a rate of zero wander far enough negative to go silent
			// for good; the client reaches that state too and empties its free list in one frame instead.
			// Capping the debt hands a little of it back, but only to emitters asking for nothing in the
			// first place: at a rate of zero it leaks 2.5 particles a second at the largest variation in
			// the client, and none at all at the common ones.
			this.grow(lifespan, tracked);
			const rate = tracked + e.emissionRateVary * rand2();
			this.emitAccumulator = Math.max(this.emitAccumulator + rate * dt, -1);
			const n = Math.max(0, Math.floor(this.emitAccumulator));
			// Only what a free slot was found for comes off the accumulator, as in the client: a full
			// pool holds the rest back as credit rather than dropping it. Emitters whose pool is as
			// tight as their steady state sit at that edge for a good part of the time.
			let emitted = 0;
			while (emitted < n && this.count < this.capacity) {
				this.spawn(animator, lifespan);
				emitted++;
			}
			this.emitAccumulator -= emitted;
		}

		this.buildQuads(basis);
	}

	/**
	 * Sizes the pool the way the client's `Sync` does, from the emitter's own life and rate as they
	 * stand. It only ever grows, so an emitter keeps the room its busiest moment asked for.
	 *
	 * A streaming emitter asks for its steady state and 15% again, so it often sits right at the pool
	 * without losing anything, the accumulator holding what it could not place. A `Squirt` one is
	 * measured by that same continuous formula though it emits in lumps, so 368 of the 630 of them
	 * cannot fit a whole burst, and the pool rather than the rate is what paces them.
	 *
	 * Rounding down means a rate and life whose product is under 1/1.15 ask for no pool at all and so
	 * emit nothing, which is what the client does with them too. It reaches 17 emitters, 4 of them on
	 * items, and each is sparse enough to be invisible anyway — the paladin shoulders want one
	 * particle every five seconds.
	 */
	private grow(lifespan: number, rate: number): void {
		const want = Math.floor((lifespan + this.emitter.lifespanVary) * (rate + this.emitter.emissionRateVary) * 1.15);
		if (want > this.capacity) this.capacity = Math.min(want, this.maxParticles);
	}

	private spawn(animator: M2Animator, lifespan: number): void {
		const e = this.emitter;
		// Seconds to add, again, not a fraction: the client's own budget sums `life + lifeVariation`,
		// which only means anything if both are times. 89 emitters can land on a life of zero or less,
		// where the client clamps to a millisecond and the particle dies before it is ever drawn.
		const life = lifespan + e.lifespanVary * rand2();
		if (life <= 0) return;
		const speed =
			animator.sampleScalar(e.emissionSpeed, "float", 0) *
			(1 + animator.sampleScalar(e.speedVariation, "float", 0) * rand2());
		const length = animator.sampleScalar(e.emissionAreaLength, "float", 0);
		const width = animator.sampleScalar(e.emissionAreaWidth, "float", 0);
		const polar = animator.sampleScalar(e.verticalRange, "float", 0) * rand2();
		const azimuth = animator.sampleScalar(e.horizontalRange, "float", 0) * rand2();

		if (e.emitterType === 2) {
			// Sphere: spawn on a shell between the two radii and travel along that radius. The sign of
			// the emission speed decides the way, so shield glows with a negative speed converge inwards.
			tmpDir.set(Math.cos(polar) * Math.cos(azimuth), Math.cos(polar) * Math.sin(azimuth), Math.sin(polar));
			const radius = length + (width - length) * Math.random();
			tmpPos.copy(tmpDir).multiplyScalar(radius);
		} else {
			// Plane: spawn in a rectangle, moving along +Z within the given cone. The length runs along the
			// bone's X axis (weapon glows span the blade with it), the width along Y.
			tmpPos.set(length * (Math.random() - 0.5), width * (Math.random() - 0.5), 0);
			tmpDir.set(Math.sin(polar) * Math.cos(azimuth), Math.sin(polar) * Math.sin(azimuth), Math.cos(polar));
		}
		// The emitter's origin rides in `toSim` (and in the mesh's matrix for a local-frame emitter),
		// so it is never added here.
		tmpPos.applyMatrix4(this.toSim);
		tmpDir.transformDirection(this.toSim).multiplyScalar(speed);

		const o = this.count++ * STRIDE;
		const p = this.particles;
		p[o] = tmpPos.x;
		p[o + 1] = tmpPos.y;
		p[o + 2] = tmpPos.z;
		p[o + 3] = tmpDir.x;
		p[o + 4] = tmpDir.y;
		p[o + 5] = tmpDir.z;
		p[o + 6] = 0;
		p[o + 7] = life;
		p[o + 8] =
			e.flags & M2ParticleFlags.ChooseRandomTexture
				? Math.floor(Math.random() * e.textureRows * e.textureCols)
				: -1;
		p[o + 9] = 1 + e.scaleVary[0] * rand2();
		p[o + 10] = e.baseSpin + e.baseSpinVary * rand2();
		// NegateSpinRandom sends half the particles the other way round.
		const flip = e.flags & M2ParticleFlags.NegateSpinRandom && Math.random() < 0.5 ? -1 : 1;
		p[o + 11] = (e.spin + e.spinVary * rand2()) * flip;
		// The client indexes the twinkle table by the particle's slot, which it keeps for life. Ours
		// move as the array compacts, so each particle carries the offset it was born with instead.
		p[o + 12] = this.twinkleCounter++ & 0x7f;
	}

	private buildQuads(basis: BillboardBasis): void {
		const e = this.emitter;
		const cols = Math.max(1, e.textureCols);
		const rows = Math.max(1, e.textureRows);
		const clampTail = (e.flags & M2ParticleFlags.ClampTailToAge) !== 0;
		const p = this.particles;
		let quad = 0;
		for (let i = 0; i < this.count; i++) {
			const o = i * STRIDE;
			const age = p[o + 6];
			const t = age / p[o + 7];
			// The step count wraps at a byte before the particle's own offset joins it, as in the client.
			const twinkle = this.twinkles ? ((Math.round(e.twinkleSpeed * age) & 0xff) + p[o + 12]) & 0x7f : 0;
			// Both halves are the client's: a percent of 1 never drops a particle, whatever the table says.
			if (this.twinkleOnOff < 1 && this.twinkleOnOff < TWINKLE_TABLE[twinkle]) continue;
			const twinkleScale = TWINKLE_TABLE[twinkle] * this.twinkleSpan + this.twinkleBase;
			samplePart(this.color, t, tmpV, 255);
			const r = tmpV[0] / 255,
				g = tmpV[1] / 255,
				b = tmpV[2] / 255;
			samplePart(e.alpha, t, tmpV, 1);
			const a = tmpV[0];
			samplePart(e.scale, t, tmpV, 1);
			// Scale is the quad's half-extent, so the sprite spans twice it. The track always carries
			// both components, so a zero height is intentional.
			const sx = tmpV[0] * p[o + 9] * this.sizeScale * twinkleScale;
			const sy = tmpV[1] * p[o + 9] * this.sizeScale * twinkleScale;
			let cell = p[o + 8];
			if (cell < 0) {
				samplePart(e.headCell, t, tmpV, 0);
				cell = Math.round(tmpV[0]);
			}
			const cu = (cell % cols) / cols;
			const cv = Math.floor(cell / cols) / rows;
			const x = p[o],
				y = p[o + 1],
				z = p[o + 2];

			if (this.head) {
				// The quad spins in its own plane, so the corner is rotated before the basis maps it out.
				const angle = p[o + 10] + p[o + 11] * age;
				const cos = Math.cos(angle),
					sin = Math.sin(angle);
				tmpAcross.copy(basis.right).multiplyScalar(cos * sx);
				tmpAcross.addScaledVector(basis.up, sin * sx);
				tmpAlong.copy(basis.up).multiplyScalar(cos * sy);
				tmpAlong.addScaledVector(basis.right, -sin * sy);
				this.writeQuad(quad++, x, y, z, cu, cv, cols, rows, r, g, b, a);
			}
			if (this.tail) {
				// A tail is stretched back over the ground the particle covered in `tailLength` seconds,
				// and lies across the view direction so the streak stays broadside to the camera.
				const span = (clampTail ? Math.min(e.tailLength, age) : e.tailLength) * 0.5;
				tmpAlong.set(p[o + 3] * span, p[o + 4] * span, p[o + 5] * span);
				tmpAcross.crossVectors(tmpAlong, basis.back);
				if (tmpAcross.lengthSq() < 1e-12) tmpAcross.copy(basis.right); // standing still: no axis to lie along
				tmpAcross.setLength(sx);
				this.writeQuad(quad++, x - tmpAlong.x, y - tmpAlong.y, z - tmpAlong.z, cu, cv, cols, rows, r, g, b, a);
			}
		}
		// Twinkle can drop particles, so the range follows the quads actually written, not the count.
		this.geometry.setDrawRange(0, quad * 6);
		if (quad === 0) return; // nothing drawn, so nothing to upload
		// Upload only the live quads instead of the whole buffer.
		const vertices = quad * 4;
		for (const attr of this.attributes) {
			attr.clearUpdateRanges();
			attr.addUpdateRange(0, vertices * attr.itemSize);
			attr.needsUpdate = true;
		}
	}

	/** Writes one quad centred on `x,y,z`, spanning `tmpAcross` and `tmpAlong`. */
	private writeQuad(
		quad: number,
		x: number,
		y: number,
		z: number,
		cu: number,
		cv: number,
		cols: number,
		rows: number,
		r: number,
		g: number,
		b: number,
		a: number,
	): void {
		const pos = this.positions;
		const uv = this.uvs;
		const col = this.colors;
		const v = quad * 4;
		for (let c = 0; c < 4; c++) {
			const k = c * 4;
			const across = CORNERS[k],
				along = CORNERS[k + 1];
			const vi = (v + c) * 3;
			pos[vi] = x + tmpAcross.x * across + tmpAlong.x * along;
			pos[vi + 1] = y + tmpAcross.y * across + tmpAlong.y * along;
			pos[vi + 2] = z + tmpAcross.z * across + tmpAlong.z * along;
			uv[(v + c) * 2] = cu + CORNERS[k + 2] / cols;
			uv[(v + c) * 2 + 1] = cv + CORNERS[k + 3] / rows;
			const ci = (v + c) * 4;
			col[ci] = r;
			col[ci + 1] = g;
			col[ci + 2] = b;
			col[ci + 3] = a;
		}
	}

	dispose(): void {
		this.geometry.dispose();
		this.material.dispose();
	}
}

function rand2(): number {
	return Math.random() * 2 - 1;
}

/** Re-expresses the camera axes of `basis` in the space `frame` maps out of. */
function basisIn(frame: Matrix4, basis: BillboardBasis): BillboardBasis {
	tmpMat.copy(frame).invert();
	tmpBasis.right.copy(basis.right).transformDirection(tmpMat);
	tmpBasis.up.copy(basis.up).transformDirection(tmpMat);
	tmpBasis.back.copy(basis.back).transformDirection(tmpMat);
	return tmpBasis;
}
