import type { AssetManager } from "../AssetManager.js";
import { M2TextureType } from "../formats/m2.js";
import { M2Instance } from "../render/M2Instance.js";
import type { M2Lighting } from "../render/M2Material.js";
import type { GameData } from "./GameData.js";
import { petScale, type PetInfo } from "./pet.js";

/** Builds creature models from CreatureDisplayInfo ids (skin variations and scale). */
export class CreatureBuilder {
	constructor(
		readonly assets: AssetManager,
		readonly data: GameData,
		readonly lighting: M2Lighting,
	) {}

	/** `pet` sizes the model the way the client sizes a character's pet (see `petScale`). */
	async build(displayId: number, pet?: PetInfo): Promise<M2Instance> {
		const cdi = (await this.data.creatureDisplayInfo()).get(displayId);
		if (!cdi) throw new Error(`Unknown display id ${displayId}`);
		const path = await this.data.displayModelPath(displayId);
		const model = await this.assets.loadModel(path);
		const inst = await M2Instance.create(model, this.assets, this.lighting);
		// TextureVariation[i] names a BLP next to the model, used by texture types 11-13.
		const types = [M2TextureType.Monster1, M2TextureType.Monster2, M2TextureType.Monster3];
		await Promise.all(
			cdi.textureVariation.map(async (name, i) => {
				if (name && inst.hasTextureType(types[i])) {
					inst.setReplaceableTexture(types[i], await this.assets.loadTexture(`${model.dir}${name}.blp`));
				}
			}),
		);
		// Some displays recolour the model's particles; the DBC is only read when one asks for it.
		if (cdi.particleColorId) {
			const row = (await this.data.particleColors()).get(cdi.particleColorId);
			if (row) inst.setParticleColors(row.colors);
		}
		// `ShowCharacter` sizes a pet by its family alone, dropping both table scales as soon as one
		// answers; anything else is the model's scale times the display's.
		const cmd = (await this.data.creatureModelData()).get(cdi.modelId);
		let scale = (cmd?.scale || 1) * (cdi.scale > 0 ? cdi.scale : 1);
		if (pet) {
			const family = (await this.data.creatureFamilies()).get(pet.family);
			const familyScale = family ? petScale(family, pet.level) : 0;
			if (familyScale > 0) scale = familyScale;
		}
		inst.scale.setScalar(scale);
		return inst;
	}
}
