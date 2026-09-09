import type { AssetManager } from "../AssetManager.js";
import type { Dbc } from "../formats/dbc.js";
import { memo } from "../util/memo.js";
import { CharSectionType, Gender } from "./constants.js";

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
	/** ParticleColor.dbc row recolouring this display's particles; 0 for none. */
	particleColorId: number;
}

export interface CreatureModelData {
	id: number;
	modelName: string;
}

/** CreatureFamily.dbc: the size a tamed pet of this family grows to between two levels. */
export interface CreatureFamily {
	id: number;
	minScale: number;
	minScaleLevel: number;
	maxScale: number;
	maxScaleLevel: number;
	name: string;
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
	/** ParticleColor.dbc row recolouring this appearance's particles; 0 for none. */
	particleColorId: number;
	/** Body region textures, see ITEM_TEXTURE_SLOTS. */
	textures: string[];
}

/**
 * ParticleColor.dbc row: three colour sets, each with a start, middle and end key. An emitter's
 * `particleColorIndex` of 11, 12 or 13 picks which set it takes.
 */
export interface ParticleColorRow {
	id: number;
	/** start[3], middle[3] then end[3], as 0xAARRGGBB. */
	colors: number[];
}

export interface HelmetGeosetVisData {
	id: number;
	/** Race bitmasks (bit `race`) for: hair, facial1, facial2, facial3, ears, misc, eyes. */
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
		return memo(this.cache as Map<string, Promise<T>>, name, () => this.assets.loadDbc(name).then(build));
	}

	/** Memoizes a value derived from one or more tables (indexes, groupings). */
	private derived<T>(key: string, build: () => Promise<T>): Promise<T> {
		return memo(this.cache as Map<string, Promise<T>>, `derived:${key}`, build);
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
					particleColorId: d.uint(i, 13),
				})),
			),
		);
	}

	creatureModelData(): Promise<Map<number, CreatureModelData>> {
		return this.table("CreatureModelData", (d) =>
			byId(d.map((i) => ({ id: d.uint(i, 0), modelName: d.string(i, 2) }))),
		);
	}

	creatureFamilies(): Promise<Map<number, CreatureFamily>> {
		return this.table("CreatureFamily", (d) =>
			byId(
				d.map((i) => ({
					id: d.uint(i, 0),
					minScale: d.float(i, 1),
					minScaleLevel: d.uint(i, 2),
					maxScale: d.float(i, 3),
					maxScaleLevel: d.uint(i, 4),
					name: d.string(i, 10),
				})),
			),
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
					particleColorId: d.uint(i, 24),
					textures: [15, 16, 17, 18, 19, 20, 21, 22].map((f) => d.string(i, f)),
				})),
			),
		);
	}

	particleColors(): Promise<Map<number, ParticleColorRow>> {
		return this.table("ParticleColor", (d) =>
			byId(d.map((i) => ({ id: d.uint(i, 0), colors: [1, 2, 3, 4, 5, 6, 7, 8, 9].map((f) => d.uint(i, f)) }))),
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

	/** Sections grouped by `race|sex`, each also indexed by `type|variation|color`. */
	private sectionIndex(): Promise<Map<string, Map<string, CharSection>>> {
		return this.derived("charSections", async () =>
			groupIndex(
				await this.charSections(),
				(s) => `${s.race}|${s.sex}`,
				(s) => `${s.type}|${s.variation}|${s.color}`,
			),
		);
	}

	private hairIndex(): Promise<Map<string, Map<string, CharHairGeoset>>> {
		return this.derived("charHairGeosets", async () =>
			groupIndex(
				await this.charHairGeosets(),
				(h) => `${h.race}|${h.sex}`,
				(h) => String(h.variation),
			),
		);
	}

	private facialIndex(): Promise<Map<string, Map<string, FacialHairStyle>>> {
		return this.derived("facialHairStyles", async () =>
			groupIndex(
				await this.facialHairStyles(),
				(f) => `${f.race}|${f.sex}`,
				(f) => String(f.variation),
			),
		);
	}

	async findCharSection(
		race: number,
		sex: number,
		type: CharSectionType,
		variation: number,
		color: number,
	): Promise<CharSection | undefined> {
		return (await this.sectionIndex()).get(`${race}|${sex}`)?.get(`${type}|${variation}|${color}`);
	}

	/**
	 * Hair sheet for a colour, taken from whichever style carries one. A bald style has none of its
	 * own, and facial hair samples the same texture slot, so orc and gnome male beards come out
	 * untextured without this; both races ship a single sheet per colour, so any style will do.
	 */
	async findHairTexture(race: number, sex: number, color: number): Promise<string | undefined> {
		const sections = await this.charSections();
		return sections.find(
			(s) =>
				s.race === race &&
				s.sex === sex &&
				s.type === CharSectionType.Hair &&
				s.color === color &&
				s.textures[0],
		)?.textures[0];
	}

	async findHairGeoset(race: number, sex: number, variation: number): Promise<CharHairGeoset | undefined> {
		return (await this.hairIndex()).get(`${race}|${sex}`)?.get(String(variation));
	}

	async findFacialHairStyle(race: number, sex: number, variation: number): Promise<FacialHairStyle | undefined> {
		return (await this.facialIndex()).get(`${race}|${sex}`)?.get(String(variation));
	}

	/** Lists valid customization values for a race/gender (character-creation sections only). */
	async customizationOptions(race: number, sex: number): Promise<CustomizationOptions> {
		const group = `${race}|${sex}`;
		const [sectionIndex, hairIndex, facialIndex] = await Promise.all([
			this.sectionIndex(),
			this.hairIndex(),
			this.facialIndex(),
		]);
		const sections = [...(sectionIndex.get(group)?.values() ?? [])];
		const uniq = (values: number[]) => [...new Set(values)].sort((a, b) => a - b);
		const of = (type: CharSectionType, key: "variation" | "color") =>
			uniq(sections.filter((s) => s.type === type).map((s) => s[key]));
		return {
			skins: of(CharSectionType.Skin, "color"),
			faces: of(CharSectionType.Face, "variation"),
			hairStyles: uniq([...(hairIndex.get(group)?.values() ?? [])].map((h) => h.variation)),
			hairColors: of(CharSectionType.Hair, "color"),
			facialStyles: uniq([...(facialIndex.get(group)?.values() ?? [])].map((f) => f.variation)),
		};
	}
}

function byId<T extends { id: number }>(rows: T[]): Map<number, T> {
	return new Map(rows.map((r) => [r.id, r]));
}

/** Two-level index; the first row wins for a duplicate key, matching a linear `find`. */
function groupIndex<T>(rows: T[], group: (row: T) => string, key: (row: T) => string): Map<string, Map<string, T>> {
	const out = new Map<string, Map<string, T>>();
	for (const row of rows) {
		const g = group(row);
		let inner = out.get(g);
		if (!inner) out.set(g, (inner = new Map()));
		const k = key(row);
		if (!inner.has(k)) inner.set(k, row);
	}
	return out;
}
