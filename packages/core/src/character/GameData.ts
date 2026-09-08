import type { AssetManager } from "../AssetManager";
import type { Dbc } from "../formats/dbc";
import { CharSectionType, Gender } from "./constants";

/** Typed views over the DBC tables needed to build characters (3.3.5a layouts). */

export interface ChrRace {
	id: number;
	maleDisplayId: number;
	femaleDisplayId: number;
	/** e.g. "Hu", used in item model file names. */
	clientPrefix: string;
	clientFileString: string;
	name: string;
}

export interface CreatureDisplayInfo {
	id: number;
	modelId: number;
	extendedDisplayInfoId: number;
	scale: number;
	textureVariation: [string, string, string];
}

export interface CreatureModelData {
	id: number;
	modelName: string;
}

export interface CharSection {
	id: number;
	race: number;
	sex: number;
	type: CharSectionType;
	textures: [string, string, string];
	flags: number;
	variation: number;
	color: number;
}

export interface CharHairGeoset {
	race: number;
	sex: number;
	variation: number;
	geoset: number;
	showScalp: boolean;
}

export interface FacialHairStyle {
	race: number;
	sex: number;
	variation: number;
	/** Geoset variants for groups 1, 3, 2, 16, 17 (in that order). */
	geosets: number[];
}

export interface ItemDisplayInfo {
	id: number;
	leftModel: string;
	rightModel: string;
	leftModelTexture: string;
	rightModelTexture: string;
	geosetGroups: [number, number, number];
	flags: number;
	/** HelmetGeosetVisData ids for male / female. */
	helmetGeosetVis: [number, number];
	/** Body region textures, see ITEM_TEXTURE_SLOTS. */
	textures: string[];
}

export interface HelmetGeosetVisData {
	id: number;
	/** Race bitmasks (bit race-1) for: hair, facial1, facial2, facial3, ears, misc, eyes. */
	hideGeoset: number[];
}

export interface ItemRecord {
	id: number;
	classId: number;
	subclassId: number;
	displayId: number;
	inventoryType: number;
	sheatheType: number;
}

/** Character customization choices available for a race/gender. */
export interface CustomizationOptions {
	skins: number[];
	faces: number[];
	hairStyles: number[];
	hairColors: number[];
	facialStyles: number[];
}

export class GameData {
	private readonly cache = new Map<string, Promise<unknown>>();

	constructor(readonly assets: AssetManager) {}

	private table<T>(name: string, build: (dbc: Dbc) => T): Promise<T> {
		let p = this.cache.get(name) as Promise<T> | undefined;
		if (!p) {
			p = this.assets.loadDbc(name).then(build);
			this.cache.set(name, p);
			p.catch(() => this.cache.delete(name));
		}
		return p;
	}

	races(): Promise<Map<number, ChrRace>> {
		return this.table("ChrRaces", (d) =>
			byId(
				d.map((i) => ({
					id: d.uint(i, 0),
					maleDisplayId: d.uint(i, 4),
					femaleDisplayId: d.uint(i, 5),
					clientPrefix: d.string(i, 6),
					clientFileString: d.string(i, 11),
					name: d.string(i, 14),
				})),
			),
		);
	}

	creatureDisplayInfo(): Promise<Map<number, CreatureDisplayInfo>> {
		return this.table("CreatureDisplayInfo", (d) =>
			byId(
				d.map((i) => ({
					id: d.uint(i, 0),
					modelId: d.uint(i, 1),
					extendedDisplayInfoId: d.uint(i, 3),
					scale: d.float(i, 4),
					textureVariation: [d.string(i, 6), d.string(i, 7), d.string(i, 8)] as [string, string, string],
				})),
			),
		);
	}

	creatureModelData(): Promise<Map<number, CreatureModelData>> {
		return this.table("CreatureModelData", (d) =>
			byId(d.map((i) => ({ id: d.uint(i, 0), modelName: d.string(i, 2) }))),
		);
	}

	charSections(): Promise<CharSection[]> {
		return this.table("CharSections", (d) =>
			d.map((i) => ({
				id: d.uint(i, 0),
				race: d.uint(i, 1),
				sex: d.uint(i, 2),
				type: d.uint(i, 3) as CharSectionType,
				textures: [d.string(i, 4), d.string(i, 5), d.string(i, 6)] as [string, string, string],
				flags: d.uint(i, 7),
				variation: d.uint(i, 8),
				color: d.uint(i, 9),
			})),
		);
	}

	charHairGeosets(): Promise<CharHairGeoset[]> {
		return this.table("CharHairGeosets", (d) =>
			d.map((i) => ({
				race: d.uint(i, 1),
				sex: d.uint(i, 2),
				variation: d.uint(i, 3),
				geoset: d.uint(i, 4),
				showScalp: d.uint(i, 5) !== 0,
			})),
		);
	}

	facialHairStyles(): Promise<FacialHairStyle[]> {
		return this.table("CharacterFacialHairStyles", (d) =>
			d.map((i) => ({
				race: d.uint(i, 0),
				sex: d.uint(i, 1),
				variation: d.uint(i, 2),
				geosets: [3, 4, 5, 6, 7].map((f) => d.uint(i, f)),
			})),
		);
	}

	itemDisplayInfo(): Promise<Map<number, ItemDisplayInfo>> {
		return this.table("ItemDisplayInfo", (d) =>
			byId(
				d.map((i) => ({
					id: d.uint(i, 0),
					leftModel: d.string(i, 1),
					rightModel: d.string(i, 2),
					leftModelTexture: d.string(i, 3),
					rightModelTexture: d.string(i, 4),
					geosetGroups: [d.uint(i, 7), d.uint(i, 8), d.uint(i, 9)] as [number, number, number],
					flags: d.uint(i, 10),
					helmetGeosetVis: [d.uint(i, 13), d.uint(i, 14)] as [number, number],
					textures: [15, 16, 17, 18, 19, 20, 21, 22].map((f) => d.string(i, f)),
				})),
			),
		);
	}

	helmetGeosetVisData(): Promise<Map<number, HelmetGeosetVisData>> {
		return this.table("HelmetGeosetVisData", (d) =>
			byId(
				d.map((i) => ({
					id: d.uint(i, 0),
					hideGeoset: [1, 2, 3, 4, 5, 6, 7].map((f) => d.uint(i, f)),
				})),
			),
		);
	}

	items(): Promise<Map<number, ItemRecord>> {
		return this.table("Item", (d) =>
			byId(
				d.map((i) => ({
					id: d.uint(i, 0),
					classId: d.uint(i, 1),
					subclassId: d.uint(i, 2),
					displayId: d.uint(i, 5),
					inventoryType: d.uint(i, 6),
					sheatheType: d.uint(i, 7),
				})),
			),
		);
	}

	/** Animation id -> name. */
	animationNames(): Promise<Map<number, string>> {
		return this.table(
			"AnimationData",
			(d) => new Map(d.map((i) => [d.uint(i, 0), d.string(i, 1)] as [number, string])),
		);
	}

	/** Client path of the character model for a race/gender. */
	async characterModelPath(race: number, gender: Gender): Promise<string> {
		const r = (await this.races()).get(race);
		if (!r) throw new Error(`Unknown race ${race}`);
		return this.displayModelPath(gender === Gender.Female ? r.femaleDisplayId : r.maleDisplayId);
	}

	/** Client path of the model behind a CreatureDisplayInfo id. */
	async displayModelPath(displayId: number): Promise<string> {
		const cdi = (await this.creatureDisplayInfo()).get(displayId);
		if (!cdi) throw new Error(`Unknown display id ${displayId}`);
		const cmd = (await this.creatureModelData()).get(cdi.modelId);
		if (!cmd) throw new Error(`Unknown model id ${cdi.modelId}`);
		return cmd.modelName;
	}

	async findCharSection(
		race: number,
		sex: number,
		type: CharSectionType,
		variation: number,
		color: number,
	): Promise<CharSection | undefined> {
		const sections = await this.charSections();
		return sections.find(
			(s) =>
				s.race === race && s.sex === sex && s.type === type && s.variation === variation && s.color === color,
		);
	}

	async findHairGeoset(race: number, sex: number, variation: number): Promise<CharHairGeoset | undefined> {
		return (await this.charHairGeosets()).find(
			(h) => h.race === race && h.sex === sex && h.variation === variation,
		);
	}

	async findFacialHairStyle(race: number, sex: number, variation: number): Promise<FacialHairStyle | undefined> {
		return (await this.facialHairStyles()).find(
			(f) => f.race === race && f.sex === sex && f.variation === variation,
		);
	}

	/** Lists valid customization values for a race/gender (character-creation sections only). */
	async customizationOptions(race: number, sex: number): Promise<CustomizationOptions> {
		const sections = (await this.charSections()).filter((s) => s.race === race && s.sex === sex);
		const uniq = (values: number[]) => [...new Set(values)].sort((a, b) => a - b);
		const of = (type: CharSectionType, key: "variation" | "color") =>
			uniq(sections.filter((s) => s.type === type).map((s) => s[key]));
		return {
			skins: of(CharSectionType.Skin, "color"),
			faces: of(CharSectionType.Face, "variation"),
			hairStyles: uniq(
				(await this.charHairGeosets()).filter((h) => h.race === race && h.sex === sex).map((h) => h.variation),
			),
			hairColors: of(CharSectionType.Hair, "color"),
			facialStyles: uniq(
				(await this.facialHairStyles()).filter((f) => f.race === race && f.sex === sex).map((f) => f.variation),
			),
		};
	}
}

function byId<T extends { id: number }>(rows: T[]): Map<number, T> {
	return new Map(rows.map((r) => [r.id, r]));
}
