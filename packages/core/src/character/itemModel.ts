import type { AssetManager } from "../AssetManager.js";
import { M2TextureType } from "../formats/m2.js";
import { M2Instance } from "../render/M2Instance.js";
import type { M2Lighting } from "../render/M2Material.js";
import { ITEM_VISUAL_ATTACHMENTS } from "./constants.js";
import type { GameData } from "./GameData.js";

/** Folders under `Item\ObjectComponents` that hold models; the rest carry textures alone. */
export const ITEM_MODEL_FOLDERS = ["Weapon", "Shield", "Head", "Shoulder", "Quiver", "Ammo"] as const;

export function stripExt(name: string): string {
	return name.replace(/\.(mdx|mdl|m2)$/i, "");
}

/** `Item\ObjectComponents\<folder>\<name>.<ext>`; DBC model names carry an .mdx extension. */
export function objectComponentPath(folder: string, name: string, ext: "m2" | "blp"): string {
	return `Item\\ObjectComponents\\${folder}\\${stripExt(name)}.${ext}`;
}

export interface ItemModelSpec {
	/** Folder under `Item\ObjectComponents`. */
	folder: string;
	/** Model name as ItemDisplayInfo spells it, extension and all. */
	model: string;
	/** ObjectSkin texture name, from the same folder. */
	texture?: string;
	/** ParticleColor.dbc row recolouring the model's particles. */
	particleColorId?: number;
	/** ItemVisuals.dbc row whose effect models hang off the item's ItemVisual attachments. */
	itemVisual?: number;
}

/** Loads one item model with its skin texture, particle colours and visual effects. */
export async function loadItemModel(
	assets: AssetManager,
	data: GameData,
	lighting: M2Lighting,
	spec: ItemModelSpec,
): Promise<M2Instance> {
	const model = await assets.loadModel(objectComponentPath(spec.folder, spec.model, "m2"));
	const inst = await M2Instance.create(model, assets, lighting);
	if (spec.texture && inst.hasTextureType(M2TextureType.ObjectSkin)) {
		inst.setReplaceableTexture(
			M2TextureType.ObjectSkin,
			await assets.loadTexture(objectComponentPath(spec.folder, spec.texture, "blp")),
		);
	}
	// Some appearances recolour the model's particles; the DBC is only read when one asks for it.
	if (spec.particleColorId) {
		const row = (await data.particleColors()).get(spec.particleColorId);
		if (row) inst.setParticleColors(row.colors);
	}
	if (spec.itemVisual) await attachItemVisuals(assets, data, lighting, inst, spec.itemVisual);
	return inst;
}

/**
 * Hangs an item visual's effect models off the item model's five ItemVisual attachments. Items
 * with none of those attachments, such as most armour, simply show nothing.
 */
export async function attachItemVisuals(
	assets: AssetManager,
	data: GameData,
	lighting: M2Lighting,
	item: M2Instance,
	visualId: number,
): Promise<void> {
	const models = await data.itemVisualModels(visualId);
	await Promise.all(
		models.map(async (path, slot) => {
			if (!path) return;
			try {
				const model = await assets.loadModel(path);
				const inst = await M2Instance.create(model, assets, lighting);
				if (!item.attachModel(inst, ITEM_VISUAL_ATTACHMENTS[slot])) inst.dispose();
			} catch (e) {
				console.warn(`Failed to attach item visual ${path}: ${e instanceof Error ? e.message : e}`);
			}
		}),
	);
}
