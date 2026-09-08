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

// Particle state layout: x y z vx vy vz age life cell scaleMul (cell < 0 = follow the head cell track)
const STRIDE = 10;
// Quad corners as (right, up, cellU, cellV): (-r,+u) (+r,+u) (+r,-u) (-r,-u).
const CORNERS = new Int8Array([-1, 1, 0, 0, 1, 1, 1, 0, 1, -1, 1, 1, -1, -1, 0, 1]);
const tmpV = new Float32Array(4);
const tmpPos = new Vector3();
const tmpDir = new Vector3();
const tmpRight = new Vector3();
const tmpUp = new Vector3();

/** Samples a life-fraction keyed track (linear). */
function samplePart(track: M2PartTrack, t: number, out: Float32Array, fallback: number): void {
	const { times, values, comp } = track;
	const n = times.length;
	if (n === 0) {
		out.fill(fallback, 0, comp);
		return;
	}
	if (n === 1 || t <= times[0]) {
		for (let i = 0; i < comp; i++) out[i] = values[i];
		return;
	}
	if (t >= times[n - 1]) {
		for (let i = 0; i < comp; i++) out[i] = values[(n - 1) * comp + i];
		return;
	}
	let k = 0;
	while (k < n - 2 && times[k + 1] <= t) k++;
	const f = (t - times[k]) / (times[k + 1] - times[k] || 1);
	for (let i = 0; i < comp; i++)
		out[i] = values[k * comp + i] + (values[(k + 1) * comp + i] - values[k * comp + i]) * f;
}

/**
 * CPU-simulated M2 particle emitter rendered as camera-facing quads in model space.
 * Simplified: no tails, spin, tumble, wind or ParticleColor.dbc overrides.
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

	constructor(
		readonly emitter: M2ParticleEmitter,
		texture: Texture,
		readonly maxParticles = 512,
	) {
		this.particles = new Float32Array(maxParticles * STRIDE);
		this.positions = new Float32Array(maxParticles * 4 * 3);
		this.uvs = new Float32Array(maxParticles * 4 * 2);
		this.colors = new Float32Array(maxParticles * 4 * 4);
		const index = new Uint16Array(maxParticles * 6);
		for (let i = 0; i < maxParticles; i++) {
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
	}

	setTexture(texture: Texture): void {
		this.material.uniforms.uTex.value = texture;
	}

	/** Simulates `dt` seconds and rebuilds the quads. `bone` is the emitter bone's model-space matrix. */
	update(dt: number, animator: M2Animator, bone: Matrix4, basis: BillboardBasis): void {
		const e = this.emitter;
		const p = this.particles;

		// Age and move existing particles (gravity along model -Z).
		const gravity = animator.sampleScalar(e.gravity, "float", 0);
		const drag = Math.max(0, 1 - e.drag * dt);
		for (let i = 0; i < this.count;) {
			const o = i * STRIDE;
			p[o + 6] += dt;
			if (p[o + 6] >= p[o + 7]) {
				this.count--;
				p.copyWithin(o, this.count * STRIDE, this.count * STRIDE + STRIDE);
				continue;
			}
			p[o + 5] -= gravity * dt;
			p[o + 3] *= drag;
			p[o + 4] *= drag;
			p[o + 5] *= drag;
			p[o] += p[o + 3] * dt;
			p[o + 1] += p[o + 4] * dt;
			p[o + 2] += p[o + 5] * dt;
			i++;
		}

		// Spawn new ones.
		if (animator.sampleScalar(e.enabledIn, "u8", 1) !== 0) {
			const rate = animator.sampleScalar(e.emissionRate, "float", 0) * (1 + e.emissionRateVary * rand2());
			this.emitAccumulator += Math.max(rate, 0) * dt;
			const n = Math.floor(this.emitAccumulator);
			this.emitAccumulator -= n;
			for (let i = 0; i < n && this.count < this.maxParticles; i++) this.spawn(animator, bone);
		}

		this.buildQuads(basis);
	}

	private spawn(animator: M2Animator, bone: Matrix4): void {
		const e = this.emitter;
		const life = animator.sampleScalar(e.lifespan, "float", 1) * (1 + e.lifespanVary * rand2());
		if (life <= 0) return;
		const speed =
			animator.sampleScalar(e.emissionSpeed, "float", 0) *
			(1 + animator.sampleScalar(e.speedVariation, "float", 0) * rand2());
		const length = animator.sampleScalar(e.emissionAreaLength, "float", 0);
		const width = animator.sampleScalar(e.emissionAreaWidth, "float", 0);
		const polar = animator.sampleScalar(e.verticalRange, "float", 0) * rand2();
		const azimuth = animator.sampleScalar(e.horizontalRange, "float", 0) * rand2();

		if (e.emitterType === 2) {
			// Sphere: spawn on a shell between the two radii, moving outwards.
			tmpDir.set(Math.cos(polar) * Math.cos(azimuth), Math.cos(polar) * Math.sin(azimuth), Math.sin(polar));
			const radius = length + (width - length) * Math.random();
			tmpPos.copy(tmpDir).multiplyScalar(radius);
			if (!(e.flags & M2ParticleFlags.Outward)) tmpDir.set(0, 0, 1);
		} else {
			// Plane: spawn in a rectangle, moving along +Z within the given cone. The "width" runs along the
			// bone's X axis (weapon glows span the blade with it), the "length" along Y.
			tmpPos.set(width * (Math.random() - 0.5), length * (Math.random() - 0.5), 0);
			tmpDir.set(Math.sin(polar) * Math.cos(azimuth), Math.sin(polar) * Math.sin(azimuth), Math.cos(polar));
		}
		tmpPos.x += e.position[0];
		tmpPos.y += e.position[1];
		tmpPos.z += e.position[2];
		tmpPos.applyMatrix4(bone);
		tmpDir.transformDirection(bone).multiplyScalar(speed);

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
			e.flags & M2ParticleFlags.RandomTexture ? Math.floor(Math.random() * e.textureRows * e.textureCols) : -1;
		p[o + 9] = 1 + e.scaleVary[0] * rand2();
	}

	private buildQuads(basis: BillboardBasis): void {
		this.geometry.setDrawRange(0, this.count * 6);
		if (this.count === 0) return; // nothing to draw, so nothing to upload
		const e = this.emitter;
		const cols = Math.max(1, e.textureCols);
		const rows = Math.max(1, e.textureRows);
		const p = this.particles;
		const pos = this.positions;
		const uv = this.uvs;
		const col = this.colors;
		for (let i = 0; i < this.count; i++) {
			const o = i * STRIDE;
			const t = p[o + 6] / p[o + 7];
			samplePart(e.color, t, tmpV, 255);
			const r = tmpV[0] / 255,
				g = tmpV[1] / 255,
				b = tmpV[2] / 255;
			samplePart(e.alpha, t, tmpV, 1);
			const a = tmpV[0];
			samplePart(e.scale, t, tmpV, 1);
			// The scale track always carries both components, so a zero height is intentional.
			const sx = tmpV[0] * 0.5 * p[o + 9];
			const sy = tmpV[1] * 0.5 * p[o + 9];
			let cell = p[o + 8];
			if (cell < 0) {
				samplePart(e.headCell, t, tmpV, 0);
				cell = Math.round(tmpV[0]);
			}
			const cu = (cell % cols) / cols;
			const cv = Math.floor(cell / cols) / rows;

			tmpRight.copy(basis.right).multiplyScalar(sx);
			tmpUp.copy(basis.up).multiplyScalar(sy);
			const x = p[o],
				y = p[o + 1],
				z = p[o + 2];
			const v = i * 4;
			for (let c = 0; c < 4; c++) {
				const k = c * 4;
				const cr = CORNERS[k],
					cuF = CORNERS[k + 1];
				const vi = (v + c) * 3;
				pos[vi] = x + tmpRight.x * cr + tmpUp.x * cuF;
				pos[vi + 1] = y + tmpRight.y * cr + tmpUp.y * cuF;
				pos[vi + 2] = z + tmpRight.z * cr + tmpUp.z * cuF;
				uv[(v + c) * 2] = cu + CORNERS[k + 2] / cols;
				uv[(v + c) * 2 + 1] = cv + CORNERS[k + 3] / rows;
				const ci = (v + c) * 4;
				col[ci] = r;
				col[ci + 1] = g;
				col[ci + 2] = b;
				col[ci + 3] = a;
			}
		}
		// Upload only the live quads instead of the whole 512-particle buffer.
		const vertices = this.count * 4;
		for (const attr of this.attributes) {
			attr.clearUpdateRanges();
			attr.addUpdateRange(0, vertices * attr.itemSize);
			attr.needsUpdate = true;
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
