import {
	BufferAttribute,
	BufferGeometry,
	DoubleSide,
	DynamicDrawUsage,
	FrontSide,
	Matrix4,
	Mesh,
	ShaderMaterial,
	Texture,
	Vector3,
} from "three";
import type { M2Animator } from "../animation/M2Animator.js";
import { M2MaterialFlags, type M2Ribbon } from "../formats/m2.js";
import { alphaTestFor, applyM2BlendMode, fogModeFor, fogUniforms, FOG_GLSL, type M2Lighting } from "./M2Material.js";

const VERTEX = /* glsl */ `
attribute vec4 aColor;
varying vec2 vUv;
varying vec4 vColor;
varying float vViewZ;
void main() {
  vUv = uv;
  vColor = aColor;
  vec4 viewPos = modelViewMatrix * vec4(position, 1.0);
  vViewZ = viewPos.z;
  gl_Position = projectionMatrix * viewPos;
}
`;

const FRAGMENT = /* glsl */ `
uniform sampler2D uTex;
uniform float uAlphaTest;
${FOG_GLSL}
varying vec2 vUv;
varying vec4 vColor;
varying float vViewZ;
void main() {
  vec4 c = texture2D(uTex, vUv) * vColor;
  if (c.a < uAlphaTest) discard;
  c.rgb = m2Fog(c.rgb, vViewZ);
  gl_FragColor = c;
}
`;

/** The shortest life the client lets an edge have, and the longest step it walks at once. */
const MIN_EDGE_LIFETIME = 0.25;
/** Half-height either way when a ribbon animates neither height track, as `Initialize` leaves it. */
const DEFAULT_HEIGHT = 10;

const tmpMat = /* @__PURE__ */ new Matrix4();
const tmpOffset = /* @__PURE__ */ new Matrix4();
/** Colour of the edges being laid down this frame, as rgba in 0..1. */
const tmpColor = /* @__PURE__ */ new Float32Array(4);

/** One end of the edge the emitter is laying down: where it is and which way it faces. */
interface Frame {
	pos: Vector3;
	up: Vector3;
	dir: Vector3;
}

const frame = (): Frame => ({ pos: new Vector3(), up: new Vector3(), dir: new Vector3() });

/**
 * CPU-simulated M2 ribbon emitter: the trail a bone drags behind it, drawn as a strip of quads.
 *
 * The emitter drops an "edge" — two points, `heightAbove` along the bone's Y and `heightBelow`
 * against it — `edgesPerSecond` times a second, and keeps each for `edgeLifetime` seconds in a ring
 * buffer. Between one frame and the next the edges are spread along a Hermite curve through the two
 * emitter positions, so a fast swing leaves a smooth arc rather than a row of steps.
 *
 * The strip lives in the instance's own space, which is the frame of reference the client lays it
 * down in: the trail follows the model around while the bone draws it from inside.
 *
 * Simplified: ribbons are drawn unlit. Their vertices carry no normal in the client either — the
 * format is position, colour and texture coordinate — so there is nothing for its lighting to read.
 */
export class RibbonSystem {
	/** One mesh per texture layer, all sharing the strip. */
	readonly meshes: Mesh[];
	private readonly materials: ShaderMaterial[];
	private readonly geometry: BufferGeometry;
	private readonly positions: Float32Array;
	private readonly uvs: Float32Array;
	private readonly colors: Float32Array;
	private readonly index: Uint16Array;
	private readonly attributes: BufferAttribute[];
	/** Age in seconds of the edge at each ring slot. */
	private readonly ages: Float32Array;
	private readonly capacity: number;
	private readonly edgesPerSecond: number;
	private readonly edgeLifetime: number;
	/** Size of one texture cell, which `textureSlot` picks among. */
	private readonly cellU: number;
	private readonly cellV: number;
	/** Oldest live edge and the one being laid down now; equal means the ribbon is empty. */
	private read = 0;
	private write = 0;
	/** How far past the last whole edge the emitter has travelled, carried between frames. */
	private fraction = 0;
	/** Whether a previous frame exists to interpolate from. */
	private started = false;
	private readonly prev = frame();
	private readonly curr = frame();
	/** Texture cell in use, as `textureSlot` last named it. */
	private slotU = 0;
	private slotV = 0;

	constructor(
		readonly ribbon: M2Ribbon,
		textures: Texture[],
		materials: { flags: number; blendMode: number }[],
		lighting: M2Lighting,
	) {
		// The pool the client sizes in `Initialize`, whole edges a second over a life of at least a
		// quarter second, plus the two the head and tail sit on.
		this.edgesPerSecond = Math.max(1, Math.ceil(ribbon.edgesPerSecond));
		this.edgeLifetime = Math.max(MIN_EDGE_LIFETIME, ribbon.edgeLifetime);
		this.capacity = Math.ceil(this.edgesPerSecond * this.edgeLifetime) + 2;
		this.cellU = 1 / Math.max(1, ribbon.textureCols);
		this.cellV = 1 / Math.max(1, ribbon.textureRows);

		const verts = this.capacity * 2;
		this.ages = new Float32Array(this.capacity);
		this.positions = new Float32Array(verts * 3);
		this.uvs = new Float32Array(verts * 2);
		this.colors = new Float32Array(verts * 4);
		this.index = new Uint16Array(this.capacity * 6);

		this.geometry = new BufferGeometry();
		this.geometry.setAttribute("position", new BufferAttribute(this.positions, 3).setUsage(DynamicDrawUsage));
		this.geometry.setAttribute("uv", new BufferAttribute(this.uvs, 2).setUsage(DynamicDrawUsage));
		this.geometry.setAttribute("aColor", new BufferAttribute(this.colors, 4).setUsage(DynamicDrawUsage));
		this.geometry.setIndex(new BufferAttribute(this.index, 1).setUsage(DynamicDrawUsage));
		this.geometry.setDrawRange(0, 0);
		this.attributes = ["position", "uv", "aColor"].map((n) => this.geometry.attributes[n] as BufferAttribute);

		this.materials = ribbon.materials.length
			? Array.from(ribbon.materials, (mi, layer) => {
					const mat = materials[mi] ?? { flags: 0, blendMode: 0 };
					const material = new ShaderMaterial({
						vertexShader: VERTEX,
						fragmentShader: FRAGMENT,
						uniforms: {
							uTex: { value: textures[layer] ?? textures[0] },
							uAlphaTest: { value: alphaTestFor(mat.blendMode) },
							...fogUniforms(
								lighting,
								fogModeFor(mat.blendMode, (mat.flags & M2MaterialFlags.Unfogged) !== 0),
							),
						},
						depthTest: !(mat.flags & M2MaterialFlags.DepthTestOff),
						depthWrite: !(mat.flags & M2MaterialFlags.DepthWriteOff),
						side: mat.flags & M2MaterialFlags.TwoSided ? DoubleSide : FrontSide,
					});
					applyM2BlendMode(material, mat.blendMode);
					return material;
				})
			: [];

		this.meshes = this.materials.map((m) => {
			const mesh = new Mesh(this.geometry, m);
			mesh.frustumCulled = false;
			// The strip is already in the instance's space, so three.js must not move it again.
			mesh.matrixAutoUpdate = false;
			return mesh;
		});
	}

	/** Assigns the texture of each layer, in the order `ribbon.textures` names them. */
	setTextures(textures: (Texture | null)[], fallback: Texture): void {
		this.materials.forEach((m, i) => {
			m.uniforms.uTex.value = textures[i] ?? fallback;
		});
	}

	/** Drops the trail, as on a fresh emitter. */
	reset(): void {
		this.read = 0;
		this.write = 0;
		this.fraction = 0;
		this.started = false;
	}

	/**
	 * Lays down `dt` seconds of trail and rebuilds the strip. `bone` is the emitter bone's
	 * model-space matrix, which is also the space the edges are kept in.
	 */
	update(dt: number, animator: M2Animator, bone: Matrix4): void {
		const r = this.ribbon;
		const visible = animator.sampleScalar(r.enabledIn, "u8", 1) !== 0;
		const above = animator.sampleScalar(r.heightAbove, "float", DEFAULT_HEIGHT);
		const below = animator.sampleScalar(r.heightBelow, "float", DEFAULT_HEIGHT);
		this.setSlot(animator.sampleScalar(r.textureSlot, "u16", 0));

		// The emitter's frame: its bone, moved out to the emitter's own origin. The client reads the
		// bone's Y as the edge's up and its Z as the way the trail is heading.
		tmpMat.copy(bone).multiply(tmpOffset.makeTranslation(r.position[0], r.position[1], r.position[2]));
		const e = tmpMat.elements;
		this.curr.pos.set(e[12], e[13], e[14]);
		this.curr.up.set(e[4], e[5], e[6]);
		this.curr.dir.set(e[8], e[9], e[10]);
		if (!this.started) {
			this.prev.pos.copy(this.curr.pos);
			this.prev.up.copy(this.curr.up);
			this.prev.dir.copy(this.curr.dir);
			this.fraction = 0;
			// The client primes a fresh emitter with one edge's worth of time rather than the frame's.
			dt = 1 / this.edgesPerSecond;
			this.started = true;
		}
		const step = Math.min(Math.max(dt, 0), this.edgeLifetime);

		// Retire whatever this step ages out.
		while (this.read !== this.write && this.ages[this.read] + step > this.edgeLifetime) {
			this.read = (this.read + 1) % this.capacity;
		}

		if (visible) {
			tmpColor[3] = animator.sampleScalar(r.alpha, "fixed16", 1);
			if (!animator.sampleVec3(r.color, tmpColor)) tmpColor[0] = tmpColor[1] = tmpColor[2] = 1;
			this.emit(step, above, below);
		}

		this.age(step);
		this.buildIndex();
		this.prev.pos.copy(this.curr.pos);
		this.prev.up.copy(this.curr.up);
		this.prev.dir.copy(this.curr.dir);
	}

	dispose(): void {
		this.geometry.dispose();
		for (const m of this.materials) m.dispose();
	}

	/** Points the texture coordinates at the cell `slot` names, left to right then top to bottom. */
	private setSlot(slot: number): void {
		const cols = Math.max(1, this.ribbon.textureCols);
		this.slotU = (slot % cols) * this.cellU;
		this.slotV = Math.floor(slot / cols) * this.cellV;
	}

	/**
	 * Spreads this step's edges along the curve from the emitter's last position to its current one,
	 * then re-lays the head edge, which tracks the emitter until the next one is dropped behind it.
	 */
	private emit(step: number, above: number, below: number): void {
		const distance = this.prev.pos.distanceTo(this.curr.pos);
		const target = step * this.edgesPerSecond + this.fraction;
		if (target >= 1) {
			const scale = 1 / (target - this.fraction);
			const count = Math.floor(target - 1) + 1;
			for (let i = 0; i < count; i++) {
				const t = (1 + i - this.fraction) * scale;
				this.writeEdge(-(t * step), t, distance, above, below);
				this.write = (this.write + 1) % this.capacity;
				// A full ring overwrites its own oldest edge, which the read cursor has to give up.
				if (this.write === this.read) this.read = (this.read + 1) % this.capacity;
			}
		}
		this.fraction = target - Math.floor(target);
		this.writeEdge(0, 1, distance, above, below);
	}

	/** Writes the edge at `t` along this step's curve into the slot the write cursor is on. */
	private writeEdge(age: number, t: number, distance: number, above: number, below: number): void {
		const s = 1 - t;
		const o = this.write * 6;
		const p = this.positions;
		for (let k = 0; k < 3; k++) {
			const prevPos = this.prev.pos.getComponent(k);
			const currPos = this.curr.pos.getComponent(k);
			const prevUp = this.prev.up.getComponent(k);
			const currUp = this.curr.up.getComponent(k);
			const startTangent = this.prev.dir.getComponent(k) * distance;
			const endTangent = this.curr.dir.getComponent(k) * distance;
			p[o + k] =
				(currPos - currUp * below - endTangent * s) * t + (prevPos - prevUp * below + startTangent * t) * s;
			p[o + 3 + k] =
				(currPos + currUp * above - endTangent * s) * t + (prevPos + prevUp * above + startTangent * t) * s;
		}
		this.ages[this.write] = age;
		const uv = this.uvs;
		const c = this.colors;
		const u = this.slotU + Math.max(age, 0) * this.cellU * (1 / this.edgeLifetime);
		uv[this.write * 4] = u;
		uv[this.write * 4 + 1] = this.slotV;
		uv[this.write * 4 + 2] = u;
		uv[this.write * 4 + 3] = this.slotV + this.cellV;
		for (let v = 0; v < 2; v++) c.set(tmpColor, this.write * 8 + v * 4);
	}

	/** Ages the live edges, drops them by the emitter's gravity and walks their texture along. */
	private age(step: number): void {
		const g = this.ribbon.gravity;
		const scale = this.cellU / this.edgeLifetime;
		for (let i = this.read; i !== this.write; i = (i + 1) % this.capacity) {
			// The client folds the whole fall into z in one go, so an edge keeps dropping as it ages.
			const drop = (this.ages[i] * 2 + step) * g * step;
			this.positions[i * 6 + 2] += drop;
			this.positions[i * 6 + 5] += drop;
			this.ages[i] += step;
			const u = this.slotU + this.ages[i] * scale;
			this.uvs[i * 4] = u;
			this.uvs[i * 4 + 2] = u;
		}
	}

	/** Joins the live edges into quads, oldest first, and uploads the frame. */
	private buildIndex(): void {
		let n = 0;
		if (this.read !== this.write) {
			for (let i = this.read; i !== this.write;) {
				const next = (i + 1) % this.capacity;
				const a = i * 2;
				const b = next * 2;
				this.index[n++] = a;
				this.index[n++] = a + 1;
				this.index[n++] = b + 1;
				this.index[n++] = a;
				this.index[n++] = b + 1;
				this.index[n++] = b;
				i = next;
			}
		}
		this.geometry.setDrawRange(0, n);
		for (const a of this.attributes) a.needsUpdate = true;
		(this.geometry.index as BufferAttribute).needsUpdate = true;
	}
}
