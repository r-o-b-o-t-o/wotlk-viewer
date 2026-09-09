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
	/**
	 * Item entry to take the appearance from instead (a transmog). Entries the client does not know
	 * are ignored, so server-side placeholders fall back to the real item.
	 */
	transmogEntry?: number;
	/** Needed to tell robes, shields, etc. apart when only `displayId` is given. */
	inventoryType?: InventoryType;
}

/** Guild crest, as stored in the emblem columns of AzerothCore's `guild` table. */
export interface GuildEmblem {
	emblemStyle: number;
	emblemColor: number;
	borderStyle: number;
	borderColor: number;
	backgroundColor: number;
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
	/** Crest to paint onto the guild tabard; without it the tabard keeps its blank default look. */
	guildEmblem?: GuildEmblem;
	showHelm?: boolean;
	showCloak?: boolean;
	showTabard?: boolean;
	/** Carry main/off-hand weapons on the back or hips instead of in the hands. */
	sheathed?: boolean;
	/**
	 * Draw the ranged weapon into the left hand. Nothing else stays in hand, and this is the only way
	 * to see it: the game never shows a ranged weapon while it is put away.
	 */
	drawRanged?: boolean;
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

/**
 * Item.dbc SheatheType -> [main-hand, off-hand] attachment when the weapon is put away. Each type has
 * its own bone with the orientation that pose needs, so picking the wrong one also tilts the weapon.
 * Type 7 ("held in off hand", tomes and the like) has no sheathed pose and is hidden instead.
 */
const SHEATH_ATTACHMENTS: Record<number, [AttachmentId, AttachmentId]> = {
	1: [AttachmentId.SheathMainHand, AttachmentId.SheathOffHand], // two-handers, hilt over the shoulder
	2: [AttachmentId.LargeWeaponLeft, AttachmentId.LargeWeaponRight], // polearms and staves across the back
	3: [AttachmentId.HipWeaponLeft, AttachmentId.HipWeaponRight], // one-handers on the hip
	4: [AttachmentId.SheathShield, AttachmentId.SheathShield], // shields, centred on the back
};
const SHEATH_HIDDEN = 7;

/** ItemDisplayInfo flag carried by the one tabard the guild crest is painted onto. */
const GUILD_TABARD_FLAG = 0x1;

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
		// Everything here is independent, so one round of requests instead of six.
		const [modelPath, raceRec, items, hair, facial, helmetVis] = await Promise.all([
			this.data.characterModelPath(race, gender),
			this.data.races().then((r) => r.get(race)!),
			this.resolveItems(app.items ?? []),
			this.data.findHairGeoset(race, sex, app.hairStyle ?? 0),
			this.data.findFacialHairStyle(race, sex, app.facialStyle ?? 0),
			this.data.helmetGeosetVisData(),
		]);
		const model = await this.assets.loadModel(modelPath);
		const body = await M2Instance.create(model, this.assets, this.lighting);

		const bySlot = new Map(items.map((i) => [i.slot, i]));
		if (app.showHelm === false) bySlot.delete(EquipmentSlot.Head);
		if (app.showCloak === false) bySlot.delete(EquipmentSlot.Back);
		if (app.showTabard === false) bySlot.delete(EquipmentSlot.Tabard);
		const chest = bySlot.get(EquipmentSlot.Chest);
		const hasRobe = !!chest && chest.display.geosetGroups[2] > 0;

		// --- geosets -----------------------------------------------------------
		const groups = new Map<number, number>();
		for (let g = 1; g <= 18; g++) groups.set(g, 1);
		groups.set(GeosetGroup.Ears, 2);
		// Geoset 1 is the bald scalp cap; bald styles reference geoset 0.
		groups.set(GeosetGroup.Hair, hair?.geoset || 1);
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
			const vis = helmetVis.get(head.display.helmetGeosetVis[sex]);
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
		const tabard = bySlot.get(EquipmentSlot.Tabard);
		// The guild tabard ships a blank white texture; the crest takes its place.
		const guildLayers =
			app.guildEmblem && tabard && tabard.display.flags & GUILD_TABARD_FLAG
				? guildTabardLayers(app.guildEmblem)
				: null;
		const itemLayers = await Promise.all(
			(hasRobe ? SLOT_ORDER_ROBE : SLOT_ORDER).flatMap((slot) => {
				const item = bySlot.get(slot);
				if (!item) return [];
				if (slot === EquipmentSlot.Tabard && guildLayers) return guildLayers.map((l) => Promise.resolve(l));
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

		const load = (path: string | undefined) => (path ? this.assets.loadTexture(path) : null);
		const [hairTex, skinExtraTex, capeTex] = await Promise.all([
			load(hairSec?.textures[0]),
			load(skinSec.textures[1]),
			load(back?.display.leftModelTexture && objectComponentPath("Cape", back.display.leftModelTexture, "blp")),
		]);
		if (hairTex) body.setReplaceableTexture(M2TextureType.Hair, hairTex);
		if (skinExtraTex) body.setReplaceableTexture(M2TextureType.SkinExtra, skinExtraTex);
		if (capeTex) body.setReplaceableTexture(M2TextureType.ObjectSkin, capeTex);

		// --- attached item models ----------------------------------------------
		const prefix = raceRec.clientPrefix + genderSuffix;
		const attachments: Promise<void>[] = [];
		if (head) {
			const d = head.display;
			// Helms come in a variant per race and gender.
			attachments.push(
				this.attachItem(
					body,
					"Head",
					`${stripExt(d.leftModel)}_${prefix}`,
					d.leftModelTexture,
					AttachmentId.Helm,
				),
			);
		}
		const shoulders = bySlot.get(EquipmentSlot.Shoulders);
		if (shoulders) {
			const d = shoulders.display;
			if (d.leftModel)
				attachments.push(
					this.attachItem(body, "Shoulder", d.leftModel, d.leftModelTexture, AttachmentId.ShoulderLeft),
				);
			if (d.rightModel)
				attachments.push(
					this.attachItem(body, "Shoulder", d.rightModel, d.rightModelTexture, AttachmentId.ShoulderRight),
				);
		}
		const taken = new Set<AttachmentId>();
		/** First candidate nothing else uses, so two weapons never share a slot. */
		const pick = (...candidates: AttachmentId[]) =>
			candidates.find((a) => !taken.has(a)) ?? candidates[candidates.length - 1];
		// A ranged weapon only ever shows drawn, never sheathed, and then it is the only thing held.
		// Sheathed melee gear still shows on the body, which with a drawn bow is the game's ranged stance.
		const melee = [EquipmentSlot.MainHand, EquipmentSlot.OffHand];
		const drawRanged = !!(app.drawRanged && bySlot.get(EquipmentSlot.Ranged)?.display.leftModel);
		const heldSlots = drawRanged ? [EquipmentSlot.Ranged, ...(app.sheathed ? melee : [])] : melee;
		for (const slot of heldSlots) {
			const item = bySlot.get(slot);
			if (!item?.display.leftModel) continue;
			const isShield = item.inventoryType === InventoryType.Shield;
			const folder = isShield ? "Shield" : "Weapon";
			const offHand = slot === EquipmentSlot.OffHand;
			let attachment: AttachmentId;
			// A drawn ranged weapon stays in hand even while the melee gear is put away.
			if (app.sheathed && slot !== EquipmentSlot.Ranged) {
				// Items with no sheathed pose simply vanish, as they do in the game.
				if (item.sheatheType === SHEATH_HIDDEN || item.inventoryType === InventoryType.Holdable) continue;
				attachment = pick(
					sheathAttachment(item, offHand),
					offHand ? AttachmentId.SheathOffHand : AttachmentId.SheathMainHand,
				);
			} else if (slot === EquipmentSlot.Ranged) {
				attachment = AttachmentId.HandLeft; // bows, guns and crossbows are carried in the left hand
			} else {
				attachment = !offHand ? AttachmentId.HandRight : isShield ? AttachmentId.Shield : AttachmentId.HandLeft;
			}
			taken.add(attachment);
			attachments.push(
				this.attachItem(body, folder, item.display.leftModel, item.display.leftModelTexture, attachment),
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
			// The transmog only supplies the look; an entry the client does not know is no transmog at all.
			const look = (it.transmogEntry !== undefined ? itemTable.get(it.transmogEntry) : undefined) ?? rec;
			const displayId = it.displayId ?? look?.displayId;
			if (!displayId) continue;
			const display = displays.get(displayId);
			if (!display) continue;
			let inventoryType =
				it.inventoryType ?? rec?.inventoryType ?? SLOT_INVENTORY_TYPE[it.slot] ?? InventoryType.NonEquip;
			// Off-hand shields when only a display id is known: guess from the model folder.
			if (it.slot === EquipmentSlot.OffHand && it.inventoryType === undefined && !rec && display.leftModel) {
				if (await this.assets.fileExists(objectComponentPath("Shield", display.leftModel, "m2")))
					inventoryType = InventoryType.Shield;
			}
			// How it is carried follows the model on show, not the item underneath.
			out.push({ slot: it.slot, display, inventoryType, sheatheType: look?.sheatheType ?? 0 });
		}
		return out;
	}

	/** Item region textures come as `<name>_<M|F>.blp` with `_U.blp` as the unisex fallback. */
	private async resolveItemTexture(folder: string, name: string, gender: string): Promise<string | null> {
		const paths = [gender, "U"].map((suffix) => `Item\\TextureComponents\\${folder}\\${name}_${suffix}.blp`);
		// Probe both at once; the gendered variant still wins when both are present.
		const found = await Promise.all(paths.map((p) => this.assets.fileExists(p)));
		const i = found.indexOf(true);
		if (i >= 0) return paths[i];
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

	/** Loads one item model from `Item\ObjectComponents\<folder>` and hangs it off `attachment`. */
	private async attachItem(
		body: M2Instance,
		folder: string,
		modelName: string,
		texture: string,
		attachment: AttachmentId,
	): Promise<void> {
		const modelPath = objectComponentPath(folder, modelName, "m2");
		try {
			const model = await this.assets.loadModel(modelPath);
			const inst = await M2Instance.create(model, this.assets, this.lighting);
			if (texture && inst.hasTextureType(M2TextureType.ObjectSkin)) {
				inst.setReplaceableTexture(
					M2TextureType.ObjectSkin,
					await this.assets.loadTexture(objectComponentPath(folder, texture, "blp")),
				);
			}
			if (!body.attachModel(inst, attachment)) inst.dispose();
		} catch (e) {
			console.warn(`Failed to attach ${modelPath}: ${e instanceof Error ? e.message : e}`);
		}
	}
}

/**
 * Guild crest layers for the two torso regions, background first. The files are pre-tinted, so the
 * colour indices pick a texture rather than a palette entry.
 */
function guildTabardLayers(e: GuildEmblem): { path: string; region: CharRegion }[] {
	const pad = (n: number) => String(n).padStart(2, "0");
	return [
		`Background_${pad(e.backgroundColor)}`,
		`Border_${pad(e.borderStyle)}_${pad(e.borderColor)}`,
		`Emblem_${pad(e.emblemStyle)}_${pad(e.emblemColor)}`,
	].flatMap((name) => [
		{ path: `Textures\\GuildEmblems\\${name}_TU_U.blp`, region: CharRegion.TorsoUpper },
		{ path: `Textures\\GuildEmblems\\${name}_TL_U.blp`, region: CharRegion.TorsoLower },
	]);
}

function stripExt(name: string): string {
	return name.replace(/\.(mdx|mdl|m2)$/i, "");
}

/** `Item\ObjectComponents\<folder>\<name>.<ext>`; DBC model names carry an .mdx extension. */
function objectComponentPath(folder: string, name: string, ext: "m2" | "blp"): string {
	return `Item\\ObjectComponents\\${folder}\\${stripExt(name)}.${ext}`;
}

/** Attachment for a put-away weapon; unknown sheathe types fall back to the back sheath. */
function sheathAttachment(item: ResolvedItem, offHand: boolean): AttachmentId {
	if (item.inventoryType === InventoryType.Shield) return AttachmentId.SheathShield;
	const pair = SHEATH_ATTACHMENTS[item.sheatheType];
	if (!pair) return offHand ? AttachmentId.SheathOffHand : AttachmentId.SheathMainHand;
	return pair[offHand ? 1 : 0];
}
