import { BufferAttribute, BufferGeometry } from "three";
import { BinaryReader } from "../io/BinaryReader";
import { M2SequenceFlags, type M2Data, type M2Track } from "../formats/m2";
import type { SkinData } from "../formats/skin";
import { readTrackKeys, type TrackKeys, type TrackKind } from "../animation/tracks";

/**
 * A loaded model shared between instances: parsed M2 + skin profile, the GPU geometry
 * and the per-sequence animation data (embedded or from external .anim files).
 */
export class M2Model {
	readonly geometry: BufferGeometry;
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
		this.geometry = buildGeometry(m2, skin);
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
		if (track.globalSeq >= 0) seq = 0;
		let cache = this.keyCache.get(track);
		if (!cache) {
			cache = new Array(this.m2.sequences.length);
			this.keyCache.set(track, cache);
		}
		const hit = cache[seq];
		if (hit !== undefined) return hit;
		if (track.timestamps.length === 0) return (cache[seq] = null);
		const r = this.seqReaders[seq];
		if (!r) return null; // not cached: may become available once the .anim file loads
		return (cache[seq] = readTrackKeys(r, track, seq, kind));
	}

	dispose(): void {
		this.geometry.dispose();
	}
}

function buildGeometry(m2: M2Data, skin: SkinData): BufferGeometry {
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
	// One draw group per batch; instances map group i to their material i.
	skin.batches.forEach((b, i) => {
		const sm = skin.submeshes[b.submeshIndex];
		g.addGroup(sm.indexStart, sm.indexCount, i);
	});
	g.computeBoundingSphere();
	return g;
}
