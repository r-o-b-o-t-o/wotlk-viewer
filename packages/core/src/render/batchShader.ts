import { M2Combiner, M2GlobalFlags, type M2Data } from "../formats/m2.js";
import type { SkinBatch, SkinData } from "../formats/skin.js";
import { PixelShader, TexCoordSource } from "./M2Material.js";

/** What one render batch actually draws, once the client's shader substitution has run. */
export interface BatchShader {
	/** A later layer folded this batch into its base, so the client never draws it. */
	skip: boolean;
	textureCount: 1 | 2;
	/** M2 texture index per layer. */
	textures: [number, number];
	/** Index into `m2.textureTransforms` per layer, -1 for none. */
	transforms: [number, number];
	texCoords: [TexCoordSource, TexCoordSource];
	pixelShader: PixelShader;
}

/** Shader id of a batch the substitution folded away. */
const SHADER_SKIP = 0x8000;
/** A `textureUnitLookup` entry above this asks for sphere-mapped coordinates. */
const COORD_ENV = 2;

/** Mutable per-batch state, mirroring the fields `CM2Shared` rewrites in place. */
interface BatchState {
	shader: number;
	textureCount: number;
	/** M2 texture index per layer: the "values" form the client converts its combos to. */
	tex: [number, number];
	/** Texture transform index per layer, -1 for none. */
	xform: [number, number];
}

/**
 * Resolves every batch of a skin profile to the draw the client would make, following
 * `CM2Shared::SubstituteSimpleShaders` and `SubstituteSpecializedShaders`. Both rewrite the batches
 * once at load time: the first turns the file's shader id into a combiner op per layer, and the
 * second folds a multi-layer material — a base pass, a sphere-mapped Mod2x or Add over it, and an
 * alpha pass on top — into the single two-texture draw the specialized shaders exist for. It takes
 * 7,246 of the client's 61,170 batches out of the draw list and sends 5,286 through a shader no
 * sequence of separate passes reproduces: `Combiners_Opaque_Mod2xNA_Alpha` fades its sphere-mapped
 * layer out against the base's own alpha rather than blending the two in the framebuffer.
 */
export function resolveBatchShaders(m2: M2Data, skin: SkinData): BatchShader[] {
	const states = skin.batches.map((b) => initialState(m2, b));
	substituteSimpleShaders(m2, skin.batches, states);
	substituteSpecializedShaders(m2, skin.batches, states);
	return states.map((s, i) => finish(m2, skin.batches[i], s));
}

function initialState(m2: M2Data, b: SkinBatch): BatchState {
	const count = Math.min(b.textureCount, 2);
	const tex = (layer: number) => (layer < count ? (m2.textureLookup[b.textureComboIndex + layer] ?? 0) : 0);
	const xform = (layer: number) =>
		layer < count ? (m2.textureTransformLookup[b.textureTransformComboIndex + layer] ?? -1) : -1;
	return {
		shader: b.shaderId,
		textureCount: count,
		tex: [tex(0), tex(1)],
		xform: [xform(0), xform(1)],
	};
}

/** The coordinate source a layer asks for, read unsigned as the client reads it: -1 becomes 0xffff. */
function coordAt(m2: M2Data, index: number): number {
	return (m2.textureUnitLookup[index] ?? 0) & 0xffff;
}

function weightAt(m2: M2Data, index: number): number {
	return m2.transparencyLookup[index] ?? -1;
}

/**
 * `CM2Shared::SubstituteSimpleShaders`: replaces the file's shader id with a combiner op per layer,
 * packed as `ops[0] << 4 | ops[1]`, each op carrying `| 8` when its layer is sphere-mapped. Without
 * the combiner-combo array the op is simply "modulate, unless the blend mode is opaque".
 */
function substituteSimpleShaders(m2: M2Data, batches: SkinBatch[], states: BatchState[]): void {
	const hasCombos = (m2.globalFlags & M2GlobalFlags.UseTextureCombinerCombos) !== 0;
	batches.forEach((b, i) => {
		const s = states[i];
		const material = m2.materials[b.materialIndex];
		if (!hasCombos) {
			const coord = coordAt(m2, b.textureCoordComboIndex);
			let op = material.blendMode !== 0 ? M2Combiner.Mod : M2Combiner.Opaque;
			if (coord > COORD_ENV) op |= 8;
			s.shader = op << 4;
			if (coord === 1) s.shader |= 0x4000;
			return;
		}
		const ops = [0, 0];
		s.shader = 0;
		for (let j = 0; j < s.textureCount; j++) {
			let op = m2.textureCombinerCombos[b.shaderId + j] ?? M2Combiner.Mod;
			if (j === 0 && material.blendMode === 0) op = M2Combiner.Opaque;
			const coord = coordAt(m2, b.textureCoordComboIndex + j);
			ops[j] = coord > COORD_ENV ? op | 8 : op;
			if (coord === 1 && j + 1 === s.textureCount) s.shader |= 0x4000;
		}
		s.shader |= ops[1] | (ops[0] << 4);
	});
}

/**
 * `CM2Shared::SubstituteSpecializedShaders`: folds the layers of a multi-layer material into one
 * draw. Two stacks are recognised, each by its own little state machine running over the batches in
 * file order. One starts from a two-texture Mod2x base and only ever ends on
 * `Combiners_Opaque_Mod2xNA_Alpha`; the other starts from a plain opaque base, folds a
 * sphere-mapped layer in, and lands on one of the other two specialized shaders — or, where that
 * layer was a Mod2x and no alpha layer follows, on the ordinary two-texture `Opaque_Mod2xNA`.
 */
function substituteSpecializedShaders(m2: M2Data, batches: SkinBatch[], states: BatchState[]): void {
	if (!batches.some((b) => b.materialLayer)) return;

	let state0 = 0;
	let state1 = 0;
	let base: BatchState | null = null;
	let baseBatch: SkinBatch | null = null;
	let materialIndex = -1;
	let sharedMaterials = false;

	for (let i = 0; i < batches.length; i++) {
		const b = batches[i];
		const s = states[i];
		if (b.materialIndex === materialIndex) {
			sharedMaterials = true;
			continue;
		}
		const op = s.shader & 7;
		const material = m2.materials[b.materialIndex];
		materialIndex = b.materialIndex;

		if (!b.materialLayer) {
			state0 = 0;
			state1 = 0;
			if (s.textureCount && material.blendMode === 0) s.shader &= 0xff8f;
			base = s;
			baseBatch = b;
		}
		if (!base || !baseBatch) continue;

		const sameWeight = weightAt(m2, baseBatch.textureWeightComboIndex) === weightAt(m2, b.textureWeightComboIndex);
		// Both machines fold an alpha layer in only when it agrees with the base on its texture, its
		// transparency track and its lit/unlit bit: it has to be the same surface, drawn over again.
		const foldableAlpha =
			(material.blendMode === 1 || material.blendMode === 2) &&
			s.textureCount === 1 &&
			((material.flags ^ m2.materials[baseBatch.materialIndex].flags) & 1) === 0 &&
			s.tex[0] === base.tex[0] &&
			sameWeight;

		if (state0 === 1) {
			if (foldableAlpha) {
				s.shader = SHADER_SKIP;
				base.shader = 0x8001;
				state0 = 3;
				continue;
			}
			state0 = 0;
		}
		if (state0 === 0) {
			// A two-texture Mod2x base whose second layer is sphere-mapped: an alpha layer after it
			// turns the pair into Opaque_Mod2xNA_Alpha.
			if (
				material.blendMode === 0 &&
				s.textureCount === 2 &&
				(op === M2Combiner.Mod2x || op === M2Combiner.Mod2xNa) &&
				coordAt(m2, b.textureCoordComboIndex) === 0 &&
				coordAt(m2, b.textureCoordComboIndex + 1) > COORD_ENV
			) {
				state0 = 1;
			}
		}

		if (state1 === 3) continue;
		if (state1 === 1) {
			if (
				(material.blendMode === 4 || material.blendMode === 6) &&
				s.textureCount === 1 &&
				coordAt(m2, b.textureCoordComboIndex) > COORD_ENV &&
				sameWeight
			) {
				s.shader = SHADER_SKIP;
				// An Add on top becomes Opaque_AddAlpha; a Mod2x becomes the plain two-texture Mod2xNA,
				// which an alpha layer after it then upgrades once more below.
				base.shader = material.blendMode !== 4 ? 0xe : 0x8002;
				base.textureCount = 2;
				base.tex[1] = s.tex[0];
				base.xform[1] = s.xform[0];
				state1 = 2;
				continue;
			}
			state1 = 0;
		} else if (state1 === 2) {
			if (foldableAlpha) {
				s.shader = SHADER_SKIP;
				state1 = 3;
				base.shader = base.shader === 0x8002 ? 0x8003 : 0x8001;
				continue;
			}
			state1 = 0;
		}

		if (material.blendMode === 0 && s.textureCount === 1 && coordAt(m2, b.textureCoordComboIndex) === 0) {
			state1 = 1;
		}
	}

	// A batch repeating the previous batch's material draws exactly what that one draws.
	if (!sharedMaterials) return;
	materialIndex = -1;
	for (let i = 0; i < batches.length; i++) {
		if (i > 0 && batches[i].materialIndex === materialIndex) {
			const prev = states[i - 1];
			states[i] = {
				shader: prev.shader,
				textureCount: prev.textureCount,
				tex: [...prev.tex],
				xform: [...prev.xform],
			};
		} else {
			materialIndex = batches[i].materialIndex;
		}
	}
}

/** Picks the pixel shader `CM2Shared::GetEffect` would build for a batch's ops. */
function pixelShaderFor(textureCount: number, shader: number): PixelShader | null {
	if (shader & SHADER_SKIP) {
		switch (shader & 0x7fff) {
			case 1:
				return PixelShader.OpaqueMod2xNAAlpha;
			case 2:
				return PixelShader.OpaqueAddAlpha;
			case 3:
				return PixelShader.OpaqueAddAlphaAlpha;
			default:
				return null;
		}
	}
	const op0 = (shader >> 4) & 7;
	const op1 = shader & 7;
	if (textureCount === 1) {
		switch (op0) {
			case M2Combiner.Opaque:
				return PixelShader.Opaque;
			case M2Combiner.Decal:
				return PixelShader.Decal;
			case M2Combiner.Add:
				return PixelShader.Add;
			case M2Combiner.Mod2x:
				return PixelShader.Mod2x;
			case M2Combiner.Fade:
				return PixelShader.Fade;
			default:
				return PixelShader.Mod;
		}
	}
	/** The six second-layer ops the client distinguishes, in its own switch order. */
	const second = (ops: [PixelShader, PixelShader, PixelShader, PixelShader, PixelShader, PixelShader]) => {
		switch (op1) {
			case M2Combiner.Opaque:
				return ops[0];
			case M2Combiner.Add:
				return ops[1];
			case M2Combiner.Mod2x:
				return ops[2];
			case M2Combiner.Mod2xNa:
				return ops[3];
			case M2Combiner.AddNa:
				return ops[4];
			default:
				return ops[5];
		}
	};
	switch (op0) {
		case M2Combiner.Opaque:
			return second([
				PixelShader.OpaqueOpaque,
				PixelShader.OpaqueAdd,
				PixelShader.OpaqueMod2x,
				PixelShader.OpaqueMod2xNA,
				PixelShader.OpaqueAddNA,
				PixelShader.OpaqueMod,
			]);
		case M2Combiner.Mod:
			return second([
				PixelShader.ModOpaque,
				PixelShader.ModAdd,
				PixelShader.ModMod2x,
				PixelShader.ModMod2xNA,
				PixelShader.ModAddNA,
				PixelShader.ModMod,
			]);
		case M2Combiner.Add:
			return op1 === M2Combiner.Mod ? PixelShader.AddMod : null;
		case M2Combiner.Mod2x:
			if (op1 === M2Combiner.Mod) return PixelShader.ModMod2x;
			return op1 === M2Combiner.Mod2x ? PixelShader.Mod2xMod2x : null;
		default:
			return null;
	}
}

function finish(m2: M2Data, b: SkinBatch, s: BatchState): BatchShader {
	const specialized = (s.shader & SHADER_SKIP) !== 0 && (s.shader & 0x7fff) !== 0;
	const coords: [TexCoordSource, TexCoordSource] = [TexCoordSource.Uv0, TexCoordSource.Uv0];
	if (specialized) {
		// The specialized shaders all pair with the client's "Diffuse_T1_Env" vertex shader.
		coords[1] = TexCoordSource.Env;
	} else {
		for (let i = 0; i < s.textureCount; i++) {
			if ((s.shader >> (4 - 4 * i)) & 8) coords[i] = TexCoordSource.Env;
			else if (coordAt(m2, b.textureCoordComboIndex + i) === 1) coords[i] = TexCoordSource.Uv1;
		}
	}
	// An op pair no effect exists for falls back to the plain modulate the client retries with.
	const pixelShader = pixelShaderFor(s.textureCount, s.shader) ?? pixelShaderFor(s.textureCount, 0x11)!;
	return {
		skip: s.shader === SHADER_SKIP,
		textureCount: s.textureCount === 2 ? 2 : 1,
		textures: [...s.tex],
		transforms: [...s.xform],
		texCoords: coords,
		pixelShader,
	};
}
