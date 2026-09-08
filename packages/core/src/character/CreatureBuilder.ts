import type { AssetManager } from "../AssetManager.js";
import { M2TextureType } from "../formats/m2.js";
import { M2Instance } from "../render/M2Instance.js";
import type { M2Lighting } from "../render/M2Material.js";
import type { GameData } from "./GameData.js";

/** Builds creature models from CreatureDisplayInfo ids (skin variations and scale). */
export class CreatureBuilder {
	constructor(
		readonly assets: AssetManager,
		readonly data: GameData,
		readonly lighting: M2Lighting,
	) {}

	async build(displayId: number): Promise<M2Instance> {
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
		if (cdi.scale > 0) inst.scale.setScalar(cdi.scale);
		return inst;
	}
}
