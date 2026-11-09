import type { AssetManager } from "../AssetManager.js";
import type { M2Instance } from "../render/M2Instance.js";
import type { M2Lighting } from "../render/M2Material.js";
import { Gender, InventoryType } from "./constants.js";
import type { GameData, ItemDisplayInfo } from "./GameData.js";
import { ITEM_MODEL_FOLDERS, loadItemModel, objectComponentPath, stripExt } from "./itemModel.js";

export interface ItemAppearance {
	/** Item entry (Item.dbc / item_template id); resolved to an appearance through Item.dbc. */
	itemEntry?: number;
	/** ItemDisplayInfo id, used when no entry is given. */
	displayId?: number;
	/** SpellItemEnchantment id whose effect hangs off the model. */
	enchant?: number;
	/** Show the item's own and its enchant's particle effects (default true). */
	showEnchants?: boolean;
	/** Show the right-hand piece of a paired appearance (shoulders) instead of the left. */
	right?: boolean;
	/** Race and gender the helm variant is cut for; helms only, default human male. */
	race?: number;
	gender?: Gender;
}

/** The folder an inventory type's model lives in; the others have no model of their own. */
const FOLDER_BY_INVENTORY_TYPE: Partial<Record<InventoryType, string>> = {
	[InventoryType.Head]: "Head",
	[InventoryType.Shoulders]: "Shoulder",
	[InventoryType.Weapon]: "Weapon",
	[InventoryType.Shield]: "Shield",
	[InventoryType.Ranged]: "Weapon",
	[InventoryType.TwoHandWeapon]: "Weapon",
	[InventoryType.WeaponMainHand]: "Weapon",
	[InventoryType.WeaponOffHand]: "Weapon",
	[InventoryType.Holdable]: "Shield",
	[InventoryType.Ammo]: "Ammo",
	[InventoryType.Thrown]: "Weapon",
	[InventoryType.RangedRight]: "Weapon",
	[InventoryType.Quiver]: "Quiver",
};

/** Folders whose models carry their own visual effects, as a held item does (see `heldItemVisual`). */
const HELD_FOLDERS = ["Weapon", "Shield"];

/**
 * Builds a single item model on its own — a weapon, shield, helm, shoulder or quiver — the way the
 * item preview windows show one. Armour that is only a body texture has no model to show.
 */
export class ItemBuilder {
	constructor(
		readonly assets: AssetManager,
		readonly data: GameData,
		readonly lighting: M2Lighting,
	) {}

	async build(item: ItemAppearance): Promise<M2Instance> {
		const { display, inventoryType } = await this.resolve(item);
		// Only shoulders come as a pair; asking for the right piece of anything else gets the one piece.
		const right = item.right && !!display.rightModel;
		const model = right ? display.rightModel : display.leftModel;
		const texture = right ? display.rightModelTexture : display.leftModelTexture;
		if (!model) throw new Error(`Item display ${display.id} has no model of its own`);

		const folder = await this.findFolder(display, model, inventoryType, item);
		if (!folder) throw new Error(`No model file for ${model} (item display ${display.id})`);
		// A held item's own effect wins over its enchant's; armour only ever shows the enchant's.
		const enchant = item.showEnchants === false ? 0 : (item.enchant ?? 0);
		const itemVisual = HELD_FOLDERS.includes(folder)
			? await this.data.heldItemVisual(enchant, display)
			: (enchant && (await this.data.spellItemEnchantments()).get(enchant)?.itemVisualId) || 0;
		return loadItemModel(this.assets, this.data, this.lighting, {
			folder,
			model: folder === "Head" ? await this.helmVariant(model, item) : model,
			texture,
			particleColorId: display.particleColorId,
			itemVisual,
			// As on a character: the string is drawn for INVTYPE_RANGED alone. An item given by display
			// id carries no inventory type, so a bow shown that way goes without one.
			bowString: inventoryType === InventoryType.Ranged,
		});
	}

	private async resolve(item: ItemAppearance): Promise<{ display: ItemDisplayInfo; inventoryType?: InventoryType }> {
		const rec = item.itemEntry !== undefined ? (await this.data.items()).get(item.itemEntry) : undefined;
		if (item.itemEntry !== undefined && !rec) throw new Error(`Unknown item ${item.itemEntry}`);
		const displayId = rec?.displayId ?? item.displayId;
		if (!displayId) throw new Error("No item entry or display id given");
		const display = (await this.data.itemDisplayInfo()).get(displayId);
		if (!display) throw new Error(`Unknown item display ${displayId}`);
		return { display, inventoryType: rec?.inventoryType };
	}

	/**
	 * The folder holding the model file. The inventory type names it; with only a display id to go on,
	 * or a type whose folder does not hold the file, the folders are probed in turn — the model names
	 * are unique across them in the 3.3.5a client.
	 */
	private async findFolder(
		display: ItemDisplayInfo,
		model: string,
		inventoryType: InventoryType | undefined,
		item: ItemAppearance,
	): Promise<string | null> {
		const preferred = inventoryType !== undefined ? FOLDER_BY_INVENTORY_TYPE[inventoryType] : undefined;
		const folders = preferred ? [preferred, ...ITEM_MODEL_FOLDERS] : ITEM_MODEL_FOLDERS;
		for (const folder of folders) {
			const name = folder === "Head" ? await this.helmVariant(model, item) : model;
			if (await this.assets.fileExists(objectComponentPath(folder, name, "m2"))) return folder;
		}
		return null;
	}

	/** Helms come in a variant per race and gender; without one the file does not exist. */
	private async helmVariant(model: string, item: ItemAppearance): Promise<string> {
		const race = (await this.data.races()).get(item.race ?? 1);
		const prefix = race?.clientPrefix ?? "Hu";
		return `${stripExt(model)}_${prefix}${item.gender === Gender.Female ? "F" : "M"}`;
	}
}
