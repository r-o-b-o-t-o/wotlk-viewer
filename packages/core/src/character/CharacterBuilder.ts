import type { AssetManager } from "../AssetManager.js";
import type { BlpImage } from "../formats/blp.js";
import { M2TextureType } from "../formats/m2.js";
import { M2Instance } from "../render/M2Instance.js";
import type { M2Lighting } from "../render/M2Material.js";
import { canvasToTexture } from "../render/textures.js";
import {
	AttachmentId,
	CharRegion,
	CharSectionType,
	EquipmentSlot,
	Gender,
	GeosetGroup,
	InventoryType,
	ITEM_TEXTURE_SLOTS,
} from "./constants.js";
import type { GameData, ItemDisplayInfo } from "./GameData.js";
import { TextureCompositor } from "./TextureCompositor.js";

export interface CharacterItem {
	slot: EquipmentSlot;
	/** ItemDisplayInfo id. Resolved from `itemEntry` through Item.dbc when omitted. */
	displayId?: number;
	/** Item entry (item_template id). */
	itemEntry?: number;
	/** Needed to tell robes, shields, etc. apart when only `displayId` is given. */
	inventoryType?: InventoryType;
}

export interface CharacterAppearance {
	race: number;
	gender: Gender;
	/** Class id; only used to enable the death knight eye glow (6). */
	classId?: number;
	skin?: number;
	face?: number;
	hairStyle?: number;
	hairColor?: number;
	facialStyle?: number;
	items?: CharacterItem[];
	showHelm?: boolean;
	showCloak?: boolean;
	/** Carry main/off-hand weapons on the back or hips instead of in the hands. */
	sheathed?: boolean;
}

interface ResolvedItem {
	slot: EquipmentSlot;
	display: ItemDisplayInfo;
	inventoryType: InventoryType;
	/** Item.dbc SheatheType (0 = none). */
	sheatheType: number;
}

/** Body regions (ITEM_TEXTURE_SLOTS indices) an item slot is allowed to paint; robes add the leg regions. */
const SLOT_TEXTURE_REGIONS: Partial<Record<EquipmentSlot, number[]>> = {
	[EquipmentSlot.Shirt]: [0, 1, 3, 4],
	[EquipmentSlot.Chest]: [0, 1, 3, 4],
	[EquipmentSlot.Waist]: [4, 5],
	[EquipmentSlot.Legs]: [5, 6],
	[EquipmentSlot.Feet]: [6, 7],
	[EquipmentSlot.Wrists]: [1],
	[EquipmentSlot.Hands]: [1, 2],
	[EquipmentSlot.Tabard]: [3, 4],
};

/** Item.dbc SheatheType -> attachment point when the weapon is put away. */
const SHEATH_ATTACHMENTS: Record<number, AttachmentId> = {
	1: AttachmentId.SheathMainHand,
	2: AttachmentId.SheathOffHand,
	3: AttachmentId.LargeWeaponLeft,
	4: AttachmentId.LargeWeaponRight,
	5: AttachmentId.HipWeaponLeft,
	6: AttachmentId.HipWeaponRight,
	7: AttachmentId.SheathShield,
};

/** Body texture draw order (later slots draw on top). */
const SLOT_ORDER = [
	EquipmentSlot.Shirt,
	EquipmentSlot.Head,
	EquipmentSlot.Shoulders,
	EquipmentSlot.Legs,
	EquipmentSlot.Feet,
	EquipmentSlot.Chest,
	EquipmentSlot.Tabard,
	EquipmentSlot.Waist,
	EquipmentSlot.Wrists,
	EquipmentSlot.Hands,
];
const SLOT_ORDER_ROBE = [
	EquipmentSlot.Shirt,
	EquipmentSlot.Head,
	EquipmentSlot.Shoulders,
	EquipmentSlot.Feet,
	EquipmentSlot.Legs,
	EquipmentSlot.Wrists,
	EquipmentSlot.Chest,
	EquipmentSlot.Hands,
	EquipmentSlot.Tabard,
	EquipmentSlot.Waist,
];

const SLOT_INVENTORY_TYPE: Partial<Record<EquipmentSlot, InventoryType>> = {
	[EquipmentSlot.Head]: InventoryType.Head,
	[EquipmentSlot.Shoulders]: InventoryType.Shoulders,
	[EquipmentSlot.Shirt]: InventoryType.Shirt,
	[EquipmentSlot.Chest]: InventoryType.Chest,
	[EquipmentSlot.Waist]: InventoryType.Waist,
	[EquipmentSlot.Legs]: InventoryType.Legs,
	[EquipmentSlot.Feet]: InventoryType.Feet,
	[EquipmentSlot.Wrists]: InventoryType.Wrists,
	[EquipmentSlot.Hands]: InventoryType.Hands,
	[EquipmentSlot.Back]: InventoryType.Cloak,
	[EquipmentSlot.MainHand]: InventoryType.WeaponMainHand,
	[EquipmentSlot.OffHand]: InventoryType.WeaponOffHand,
	[EquipmentSlot.Ranged]: InventoryType.Ranged,
	[EquipmentSlot.Tabard]: InventoryType.Tabard,
};

/**
 * Assembles a player character: body model, composited skin, hair/facial geosets,
 * equipment textures and attached item models (helm, shoulders, weapons, shield).
 */
export class CharacterBuilder {
	constructor(
		readonly assets: AssetManager,
		readonly data: GameData,
		readonly lighting: M2Lighting,
	) {}

	async build(app: CharacterAppearance): Promise<M2Instance> {
		const { race, gender } = app;
		const sex = gender === Gender.Female ? 1 : 0;
		const [modelPath, raceRec, items] = await Promise.all([
			this.data.characterModelPath(race, gender),
			this.data.races().then((r) => r.get(race)!),
			this.resolveItems(app.items ?? []),
		]);
		const model = await this.assets.loadModel(modelPath);
		const body = await M2Instance.create(model, this.assets, this.lighting);

		const bySlot = new Map(items.map((i) => [i.slot, i]));
		if (app.showHelm === false) bySlot.delete(EquipmentSlot.Head);
		if (app.showCloak === false) bySlot.delete(EquipmentSlot.Back);
		const chest = bySlot.get(EquipmentSlot.Chest);
		const hasRobe = !!chest && chest.display.geosetGroups[2] > 0;

		// --- geosets -----------------------------------------------------------
		const groups = new Map<number, number>();
		for (let g = 1; g <= 18; g++) groups.set(g, 1);
		groups.set(GeosetGroup.Ears, 2);
		const hair = await this.data.findHairGeoset(race, sex, app.hairStyle ?? 0);
		// Geoset 1 is the bald scalp cap; bald styles reference geoset 0.
		groups.set(GeosetGroup.Hair, hair?.geoset || 1);
		const facial = await this.data.findFacialHairStyle(race, sex, app.facialStyle ?? 0);
		const fg = facial?.geosets ?? [0, 0, 0, 0, 0];
		groups.set(GeosetGroup.Facial1, fg[0]);
		groups.set(GeosetGroup.Facial3, fg[1]);
		groups.set(GeosetGroup.Facial2, fg[2]);
		groups.set(GeosetGroup.Facial4, fg[3]);
		groups.set(GeosetGroup.EyeGlow, app.classId === 6 ? 3 : fg[4]);

		const setGroup = (group: GeosetGroup, value: number) => {
			if (value > 0) groups.set(group, 1 + value);
		};
		const shirt = bySlot.get(EquipmentSlot.Shirt);
		if (shirt) {
			setGroup(GeosetGroup.Sleeves, shirt.display.geosetGroups[0]);
			setGroup(GeosetGroup.Chest, shirt.display.geosetGroups[1]);
		}
		const legs = bySlot.get(EquipmentSlot.Legs);
		if (legs) {
			setGroup(GeosetGroup.Pants, legs.display.geosetGroups[0]);
			setGroup(GeosetGroup.Kneepads, legs.display.geosetGroups[1]);
			setGroup(GeosetGroup.Trousers, legs.display.geosetGroups[2]);
		}
		if (chest) {
			setGroup(GeosetGroup.Sleeves, chest.display.geosetGroups[0]);
			setGroup(GeosetGroup.Chest, chest.display.geosetGroups[1]);
			setGroup(GeosetGroup.Trousers, chest.display.geosetGroups[2]);
		}
		const feet = bySlot.get(EquipmentSlot.Feet);
		if (feet) setGroup(GeosetGroup.Boots, feet.display.geosetGroups[0]);
		const hands = bySlot.get(EquipmentSlot.Hands);
		if (hands) setGroup(GeosetGroup.Gloves, hands.display.geosetGroups[0]);
		const waist = bySlot.get(EquipmentSlot.Waist);
		if (waist) setGroup(GeosetGroup.Belt, waist.display.geosetGroups[0]);
		const back = bySlot.get(EquipmentSlot.Back);
		if (back) setGroup(GeosetGroup.Cloak, back.display.geosetGroups[0]);
		if (bySlot.has(EquipmentSlot.Tabard) && !hasRobe) groups.set(GeosetGroup.Tabard, 2);
		if (hasRobe) {
			// Robes replace the trouser geoset and cover kneepads/boot tops.
			groups.set(GeosetGroup.Kneepads, 1);
		}

		// Helmets hide hair / facial geosets per race.
		let hideHair = false;
		const head = bySlot.get(EquipmentSlot.Head);
		if (head) {
			const vis = (await this.data.helmetGeosetVisData()).get(head.display.helmetGeosetVis[sex]);
			if (vis) {
				const bit = 1 << (race - 1);
				const hides = (i: number) => (vis.hideGeoset[i] & bit) !== 0;
				if (hides(0)) {
					groups.set(GeosetGroup.Hair, 1);
					hideHair = true;
				}
				if (hides(1)) groups.set(GeosetGroup.Facial1, 0);
				if (hides(2)) groups.set(GeosetGroup.Facial2, 0);
				if (hides(3)) groups.set(GeosetGroup.Facial3, 0);
				if (hides(4)) groups.set(GeosetGroup.Ears, 0);
			}
		}
		body.setGeosetFilter((id) => id === 0 || groups.get(Math.floor(id / 100)) === id % 100);

		// --- textures ----------------------------------------------------------
		const skinColor = app.skin ?? 0;
		const hairColor = app.hairColor ?? 0;
		const section = (type: CharSectionType, variation: number, color: number) =>
			this.data.findCharSection(race, sex, type, variation, color);
		const [skinSec, faceSec, facialSec, hairSec, underwearSec] = await Promise.all([
			section(CharSectionType.Skin, 0, skinColor),
			section(CharSectionType.Face, app.face ?? 0, skinColor),
			section(CharSectionType.FacialHair, app.facialStyle ?? 0, hairColor),
			section(CharSectionType.Hair, app.hairStyle ?? 0, hairColor),
			section(CharSectionType.Underwear, 0, skinColor),
		]);
		if (!skinSec) throw new Error(`No skin section for race ${race} sex ${sex} color ${skinColor}`);

		const layers: { path: string; region?: CharRegion }[] = [{ path: skinSec.textures[0] }];
		const push = (path: string | undefined, region?: CharRegion) => {
			if (path) layers.push({ path, region });
		};
		push(faceSec?.textures[0], CharRegion.FaceLower);
		push(faceSec?.textures[1], CharRegion.FaceUpper);
		push(facialSec?.textures[0], CharRegion.FaceLower);
		push(facialSec?.textures[1], CharRegion.FaceUpper);
		if (hair?.showScalp || hideHair || !hair) {
			push(hairSec?.textures[1], CharRegion.FaceLower);
			push(hairSec?.textures[2], CharRegion.FaceUpper);
		}
		push(underwearSec?.textures[0], CharRegion.PelvisUpper);
		push(underwearSec?.textures[1], CharRegion.TorsoUpper);

		const genderSuffix = sex === 1 ? "F" : "M";
		const itemLayers = await Promise.all(
			(hasRobe ? SLOT_ORDER_ROBE : SLOT_ORDER).flatMap((slot) => {
				const item = bySlot.get(slot);
				if (!item) return [];
				// ItemDisplayInfo carries textures for the whole armor set; only the slot's own regions apply.
				const allowed = [...(SLOT_TEXTURE_REGIONS[slot] ?? [])];
				if (slot === EquipmentSlot.Chest && hasRobe) allowed.push(5, 6);
				return ITEM_TEXTURE_SLOTS.flatMap(({ folder, region }, i) => {
					const name = allowed.includes(i) ? item.display.textures[i] : "";
					return name
						? [this.resolveItemTexture(folder, name, genderSuffix).then((path) => ({ path, region }))]
						: [];
				});
			}),
		);
		for (const l of itemLayers) if (l.path) layers.push(l as { path: string; region: CharRegion });

		const images = await Promise.all(layers.map((l) => this.loadImage(l.path)));
		const base = images[0];
		if (!base) throw new Error(`Missing skin texture ${skinSec.textures[0]}`);
		const compositor = new TextureCompositor(base.width, base.height);
		layers.forEach((l, i) => {
			if (images[i]) compositor.draw(images[i]!, l.region);
		});
		const skinTexture = canvasToTexture(compositor.canvas);
		body.ownTexture(skinTexture); // built here, so this instance has to free it
		body.setReplaceableTexture(M2TextureType.Skin, skinTexture);

		if (hairSec?.textures[0])
			body.setReplaceableTexture(M2TextureType.Hair, await this.assets.loadTexture(hairSec.textures[0]));
		if (skinSec.textures[1])
			body.setReplaceableTexture(M2TextureType.SkinExtra, await this.assets.loadTexture(skinSec.textures[1]));
		if (back?.display.leftModelTexture) {
			body.setReplaceableTexture(
				M2TextureType.ObjectSkin,
				await this.assets.loadTexture(`Item\\ObjectComponents\\Cape\\${back.display.leftModelTexture}.blp`),
			);
		}

		// --- attached item models ----------------------------------------------
		const prefix = raceRec.clientPrefix + genderSuffix;
		const attachments: Promise<void>[] = [];
		if (head) {
			attachments.push(
				this.attachItem(
					body,
					`Item\\ObjectComponents\\Head\\${stripExt(head.display.leftModel)}_${prefix}.m2`,
					head.display.leftModelTexture,
					"Head",
					AttachmentId.Helm,
				),
			);
		}
		const shoulders = bySlot.get(EquipmentSlot.Shoulders);
		if (shoulders) {
			const d = shoulders.display;
			if (d.leftModel)
				attachments.push(
					this.attachItem(
						body,
						`Item\\ObjectComponents\\Shoulder\\${stripExt(d.leftModel)}.m2`,
						d.leftModelTexture,
						"Shoulder",
						AttachmentId.ShoulderLeft,
					),
				);
			if (d.rightModel)
				attachments.push(
					this.attachItem(
						body,
						`Item\\ObjectComponents\\Shoulder\\${stripExt(d.rightModel)}.m2`,
						d.rightModelTexture,
						"Shoulder",
						AttachmentId.ShoulderRight,
					),
				);
		}
		const taken = new Set<AttachmentId>();
		/** First candidate nothing else uses, so two weapons never share a slot. */
		const pick = (...candidates: AttachmentId[]) =>
			candidates.find((a) => !taken.has(a)) ?? candidates[candidates.length - 1];
		for (const slot of [EquipmentSlot.MainHand, EquipmentSlot.OffHand, EquipmentSlot.Ranged]) {
			const item = bySlot.get(slot);
			if (!item?.display.leftModel) continue;
			const isShield = item.inventoryType === InventoryType.Shield;
			const folder = isShield ? "Shield" : "Weapon";
			let attachment: AttachmentId;
			if (slot === EquipmentSlot.Ranged) {
				// Ranged weapons hang on the back, beside whatever is already sheathed there.
				attachment = pick(AttachmentId.SheathMainHand, AttachmentId.SheathOffHand);
			} else if (app.sheathed) {
				if (item.inventoryType === InventoryType.Holdable) continue; // held items vanish when sheathed
				const offHand = slot === EquipmentSlot.OffHand;
				attachment = pick(
					sheathAttachment(item, offHand),
					offHand ? AttachmentId.SheathOffHand : AttachmentId.SheathMainHand,
				);
			} else {
				attachment =
					slot === EquipmentSlot.MainHand
						? AttachmentId.HandRight
						: isShield
							? AttachmentId.Shield
							: AttachmentId.HandLeft;
			}
			taken.add(attachment);
			attachments.push(
				this.attachItem(
					body,
					`Item\\ObjectComponents\\${folder}\\${stripExt(item.display.leftModel)}.m2`,
					item.display.leftModelTexture,
					folder,
					attachment,
				),
			);
		}
		await Promise.all(attachments);
		return body;
	}

	private async resolveItems(items: CharacterItem[]): Promise<ResolvedItem[]> {
		const [displays, itemTable] = await Promise.all([this.data.itemDisplayInfo(), this.data.items()]);
		const out: ResolvedItem[] = [];
		for (const it of items) {
			const rec = it.itemEntry !== undefined ? itemTable.get(it.itemEntry) : undefined;
			const displayId = it.displayId ?? rec?.displayId;
			if (!displayId) continue;
			const display = displays.get(displayId);
			if (!display) continue;
			let inventoryType =
				it.inventoryType ?? rec?.inventoryType ?? SLOT_INVENTORY_TYPE[it.slot] ?? InventoryType.NonEquip;
			// Off-hand shields when only a display id is known: guess from the model folder.
			if (it.slot === EquipmentSlot.OffHand && it.inventoryType === undefined && !rec && display.leftModel) {
				if (await this.assets.fileExists(`Item\\ObjectComponents\\Shield\\${stripExt(display.leftModel)}.m2`))
					inventoryType = InventoryType.Shield;
			}
			out.push({ slot: it.slot, display, inventoryType, sheatheType: rec?.sheatheType ?? 0 });
		}
		return out;
	}

	/** Item region textures come as `<name>_<M|F>.blp` with `_U.blp` as the unisex fallback. */
	private async resolveItemTexture(folder: string, name: string, gender: string): Promise<string | null> {
		for (const suffix of [gender, "U"]) {
			const path = `Item\\TextureComponents\\${folder}\\${name}_${suffix}.blp`;
			if (await this.assets.fileExists(path)) return path;
		}
		console.warn(`Missing item texture ${folder}/${name}`);
		return null;
	}

	private async loadImage(path: string): Promise<BlpImage | null> {
		try {
			return await this.assets.loadBlp(path);
		} catch (e) {
			console.warn(`Failed to load ${path}: ${e instanceof Error ? e.message : e}`);
			return null;
		}
	}

	private async attachItem(
		body: M2Instance,
		modelPath: string,
		texture: string,
		folder: string,
		attachment: AttachmentId,
	): Promise<void> {
		try {
			const model = await this.assets.loadModel(modelPath);
			const inst = await M2Instance.create(model, this.assets, this.lighting);
			if (texture && inst.hasTextureType(M2TextureType.ObjectSkin)) {
				inst.setReplaceableTexture(
					M2TextureType.ObjectSkin,
					await this.assets.loadTexture(`Item\\ObjectComponents\\${folder}\\${texture}.blp`),
				);
			}
			if (!body.attachModel(inst, attachment)) inst.dispose();
		} catch (e) {
			console.warn(`Failed to attach ${modelPath}: ${e instanceof Error ? e.message : e}`);
		}
	}
}

function stripExt(name: string): string {
	return name.replace(/\.(mdx|mdl|m2)$/i, "");
}

/** Attachment for a put-away weapon; off-hand copies of "left" sheath types use the right-hand variant. */
function sheathAttachment(item: ResolvedItem, offHand: boolean): AttachmentId {
	if (item.inventoryType === InventoryType.Shield) return AttachmentId.SheathShield;
	const a = SHEATH_ATTACHMENTS[item.sheatheType];
	if (a === undefined) return offHand ? AttachmentId.SheathOffHand : AttachmentId.SheathMainHand;
	if (!offHand) return a;
	if (a === AttachmentId.LargeWeaponLeft) return AttachmentId.LargeWeaponRight;
	if (a === AttachmentId.HipWeaponLeft) return AttachmentId.HipWeaponRight;
	if (a === AttachmentId.SheathMainHand) return AttachmentId.SheathOffHand;
	return a;
}
