import {
	BufferAttribute,
	BufferGeometry,
	DynamicDrawUsage,
	Line,
	LineBasicMaterial,
	LinearSRGBColorSpace,
	Matrix4,
	Vector3,
} from "three";
import type { M2Data, M2Event } from "../formats/m2.js";

/**
 * The two ends of the string, at the tips of a bow's limbs. A weapon trail hangs off the same pair,
 * so plenty of models that are not bows carry them; who gets a string is the caller's call.
 */
const TOP_EVENT = "$WTT";
const BOTTOM_EVENT = "$WTB";

/** The client quantises its colour to 8 bits per channel, which clamps it on the way. */
const clamp = (v: number) => (v > 0 ? (v < 1 ? v : 1) : 0);

/**
 * The string the client draws between a bow's limb tips, `CDrawBowString::DrawBowString`: two
 * untextured, unlit lines from the top anchor through the draw hand to the bottom one, coloured
 * with the scene's ambient. The anchors are the `$WTT` and `$WTB` events, each on a limb's own
 * bone, so the string follows the limbs as the bow animates.
 *
 * The middle point is where an archer's draw hand holds the nock. The client only has one while a
 * unit is in ranged mode, where it takes the unit's arrow-hand attachment, and uses the midpoint of
 * the two anchors otherwise, which leaves the string straight. That is the form here, and the only
 * one a glue screen ever shows, since its callback passes no unit.
 */
export class BowString {
	readonly line: Line;
	private readonly positions: BufferAttribute;
	private readonly geometry: BufferGeometry;
	private readonly material: LineBasicMaterial;

	private constructor(
		private readonly top: M2Event,
		private readonly bottom: M2Event,
	) {
		this.geometry = new BufferGeometry();
		this.positions = new BufferAttribute(new Float32Array(9), 3);
		this.positions.setUsage(DynamicDrawUsage);
		this.geometry.setAttribute("position", this.positions);
		this.material = new LineBasicMaterial({ fog: false, toneMapped: false });
		this.line = new Line(this.geometry, this.material);
		this.line.frustumCulled = false;
	}

	/** A string for this model, or null unless it carries both anchors on bones it has. */
	static create(m2: M2Data): BowString | null {
		const find = (id: string) => m2.events.find((e) => e.id === id && e.bone < m2.bones.length) ?? null;
		const top = find(TOP_EVENT);
		const bottom = find(BOTTOM_EVENT);
		return top && bottom ? new BowString(top, bottom) : null;
	}

	/** Re-anchors the string to the animated limbs and takes the scene's ambient as its colour. */
	update(boneMatrices: Matrix4[], ambient: Vector3): void {
		const p = this.positions.array as Float32Array;
		anchor(boneMatrices, this.top, p, 0);
		anchor(boneMatrices, this.bottom, p, 6);
		for (let i = 0; i < 3; i++) p[3 + i] = (p[i] + p[6 + i]) * 0.5;
		this.positions.needsUpdate = true;
		this.material.color.setRGB(clamp(ambient.x), clamp(ambient.y), clamp(ambient.z), LinearSRGBColorSpace);
	}

	dispose(): void {
		this.geometry.dispose();
		this.material.dispose();
	}
}

/** Stands in for a bone the animator has no matrix for; never written to. */
const IDENTITY = new Matrix4();

/** Writes an event's animated position into `out` at `offset`. */
function anchor(boneMatrices: Matrix4[], event: M2Event, out: Float32Array, offset: number): void {
	const bone = boneMatrices[event.bone] ?? IDENTITY;
	const [x, y, z] = event.position;
	const e = bone.elements;
	out[offset] = e[0] * x + e[4] * y + e[8] * z + e[12];
	out[offset + 1] = e[1] * x + e[5] * y + e[9] * z + e[13];
	out[offset + 2] = e[2] * x + e[6] * y + e[10] * z + e[14];
}
