import { BufferAttribute, BufferGeometry } from "three";
import { BinaryReader } from "../io/BinaryReader.js";
import { M2BlendMode, M2SequenceFlags, type M2Data, type M2Track } from "../formats/m2.js";
import type { SkinBatch, SkinData } from "../formats/skin.js";
import { readTrackKeys, type TrackKeys, type TrackKind } from "../animation/tracks.js";
import { resolveBatchShaders, type BatchShader } from "./batchShader.js";

/**
 * A loaded model shared between instances: parsed M2 + skin profile, the GPU geometry
 * and the per-sequence animation data (embedded or from external .anim files).
 */
export class M2Model {
	readonly geometry: BufferGeometry;
	/** What each skin batch draws once the client's shader substitution has run. */
	readonly batchShaders: BatchShader[];
	/** Directory of the model, with trailing slash. */
	readonly dir: string;
	readonly name: string;
	private readonly seqReaders: (BinaryReader | undefined)[];
	private readonly keyCache = new WeakMap<M2Track, (TrackKeys | null | undefined)[]>();

	constructor(
		readonly path: string,
		readonly m2: M2Data,
		readonly skin: SkinData,
	) {
		const norm = path.replace(/\\/g, "/");
		this.dir = norm.slice(0, norm.lastIndexOf("/") + 1);
		this.name = norm.slice(this.dir.length).replace(/\.(m2|mdx|mdl)$/i, "");
		this.batchShaders = resolveBatchShaders(m2, skin);
		this.geometry = buildGeometry(m2, skin, this.batchShaders);
		this.seqReaders = m2.sequences.map((s) => (s.flags & M2SequenceFlags.Embedded ? m2.reader : undefined));
	}

	get boneCount(): number {
		return this.m2.bones.length;
	}

	/** Path of the external .anim file holding `seq`, or null when embedded. */
	animFilePath(seq: number): string | null {
		const s = this.m2.sequences[seq];
		if (s.flags & M2SequenceFlags.Embedded) return null;
		const id = String(s.id).padStart(4, "0");
		const variation = String(s.variationIndex).padStart(2, "0");
		return `${this.dir}${this.name}${id}-${variation}.anim`;
	}

	isSequenceLoaded(seq: number): boolean {
		return this.seqReaders[seq] !== undefined;
	}

	setSequenceData(seq: number, data: ArrayBuffer): void {
		this.seqReaders[seq] = new BinaryReader(data);
	}

	/** Follows alias links to the sequence that actually holds the animation data. */
	resolveAlias(seq: number): number {
		const seqs = this.m2.sequences;
		for (let guard = 0; guard < 32 && seqs[seq].flags & M2SequenceFlags.Alias; guard++) {
			const next = seqs[seq].aliasNext;
			if (next === seq || next >= seqs.length) break;
			seq = next;
		}
		return seq;
	}

	/** Sequence index for an animation id (AnimationData.dbc) and variation, or -1. */
	findSequence(animId: number, variation = 0): number {
		const lookup = this.m2.sequenceLookup;
		if (animId < 0 || animId >= lookup.length) return -1;
		let seq = lookup[animId];
		for (let v = 0; v < variation && seq >= 0; v++) seq = this.m2.sequences[seq].variationNext;
		return seq;
	}

	/** All sequence indices for an animation id, in variation order. */
	sequenceVariations(animId: number): number[] {
		const out: number[] = [];
		let seq = this.findSequence(animId);
		for (let guard = 0; seq >= 0 && guard < 64; guard++) {
			out.push(seq);
			seq = this.m2.sequences[seq].variationNext;
		}
		return out;
	}

	/** Distinct animation ids present in the model, in sequence order. */
	animationIds(): number[] {
		const ids = new Set<number>();
		for (const s of this.m2.sequences) ids.add(s.id);
		return [...ids];
	}

	/**
	 * Decoded keys of `track` for sequence `seq` (already alias-resolved).
	 * Null when the track has no data or the sequence data is not loaded yet.
	 */
	keys(track: M2Track, seq: number, kind: TrackKind): TrackKeys | null {
		// Global sequences are keyed by slot 0 and their data always lives in the .m2 itself.
		const global = track.globalSeq >= 0;
		// `M2AnimateTrack` reads slot 0 past a track's end too: one slot holding one key is a constant.
		if (global || seq >= track.timestamps.length) seq = 0;
		let cache = this.keyCache.get(track);
		if (!cache) {
			cache = new Array(this.m2.sequences.length);
			this.keyCache.set(track, cache);
		}
		const hit = cache[seq];
		if (hit !== undefined) return hit;
		if (track.timestamps.length === 0) return (cache[seq] = null);
		const r = global ? this.m2.reader : this.seqReaders[seq];
		if (!r) return null; // not cached: may become available once the .anim file loads
		return (cache[seq] = readTrackKeys(r, track, seq, kind));
	}

	dispose(): void {
		this.geometry.dispose();
	}
}

function buildGeometry(m2: M2Data, skin: SkinData, shaders: BatchShader[]): BufferGeometry {
	const src = m2.vertices;
	const n = skin.vertices.length;
	const positions = new Float32Array(n * 3);
	const normals = new Float32Array(n * 3);
	const uv0 = new Float32Array(n * 2);
	const uv1 = new Float32Array(n * 2);
	const skinIndex = new Uint16Array(n * 4);
	const skinWeight = new Float32Array(n * 4);
	for (let i = 0; i < n; i++) {
		const v = skin.vertices[i];
		for (let k = 0; k < 3; k++) {
			positions[i * 3 + k] = src.positions[v * 3 + k];
			normals[i * 3 + k] = src.normals[v * 3 + k];
		}
		for (let k = 0; k < 2; k++) {
			uv0[i * 2 + k] = src.uv0[v * 2 + k];
			uv1[i * 2 + k] = src.uv1[v * 2 + k];
		}
		for (let k = 0; k < 4; k++) {
			skinIndex[i * 4 + k] = src.boneIndices[v * 4 + k];
			skinWeight[i * 4 + k] = src.boneWeights[v * 4 + k] / 255;
		}
	}
	const g = new BufferGeometry();
	g.setAttribute("position", new BufferAttribute(positions, 3));
	g.setAttribute("normal", new BufferAttribute(normals, 3));
	g.setAttribute("uv", new BufferAttribute(uv0, 2));
	g.setAttribute("uv1", new BufferAttribute(uv1, 2));
	g.setAttribute("skinIndex", new BufferAttribute(skinIndex, 4));
	g.setAttribute("skinWeight", new BufferAttribute(skinWeight, 4));
	g.setIndex(new BufferAttribute(skin.indices, 1));
	// One draw group per batch; instances map group i to their material i. Groups of a single mesh keep
	// this order, and it is the order the translucent ones are drawn in, so it decides what paints
	// over what.
	//
	// `priorityPlane` leads, being the artist's own layering: Acherus puts its Icecrown sky bowl on
	// plane 0 and the mountains inside it on 9, and taken in file order the bowl lands on top of them
	// as a dark band across the sky. Only about one model in twenty sets it at all.
	//
	// Additive batches come last within a plane: they are glow decals, and a translucent layer over
	// the surface behind them would otherwise paint them out (the rune on Titansteel Shield Wall).
	// The layers of one material are exempt and keep the `materialLayer` order the client's own
	// comparator gives them: a stack is one surface painted over and over, and lifting its additive
	// layer to the end of the plane composites it outside the alpha layer that should cover it.
	const isGlow = (i: number) => {
		const mode = m2.materials[skin.batches[i].materialIndex].blendMode;
		return mode === M2BlendMode.Add || mode === M2BlendMode.NoAlphaAdd ? 1 : 0;
	};
	// A stack therefore sorts as a whole, on its base batch. It is not a run of consecutive batches —
	// two submeshes sharing a three-layer material interleave as 0,0,1,1,2,2 (Lady Alexstrasza) — so
	// the base is found by submesh and by `materialIndex - materialLayer`, the base material the
	// client derives the same way. Over the whole client every batch has exactly one base on that
	// key, it always comes earlier in the file, and the two agree on the priority plane.
	const stackKey = (b: SkinBatch) => `${b.submeshIndex}:${b.materialIndex - b.materialLayer}`;
	const bases = new Map<string, number>();
	skin.batches.forEach((b, i) => {
		if (b.materialLayer === 0 && !bases.has(stackKey(b))) bases.set(stackKey(b), i);
	});
	const baseOf = skin.batches.map((b, i) => bases.get(stackKey(b)) ?? i);
	// A batch the substitution folded into another one's draw gets no group: it is not drawn at all.
	const order = skin.batches.map((_, i) => i).filter((i) => !shaders[i].skip);
	order.sort(
		(a, b) =>
			skin.batches[a].priorityPlane - skin.batches[b].priorityPlane ||
			isGlow(baseOf[a]) - isGlow(baseOf[b]) ||
			baseOf[a] - baseOf[b] ||
			skin.batches[a].materialLayer - skin.batches[b].materialLayer,
	);
	for (const i of order) {
		const sm = skin.submeshes[skin.batches[i].submeshIndex];
		g.addGroup(sm.indexStart, sm.indexCount, i);
	}
	g.computeBoundingSphere();
	return g;
}
