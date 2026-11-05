import type { AssetManager } from "../AssetManager.js";
import { M2Instance } from "../render/M2Instance.js";
import type { M2Lighting } from "../render/M2Material.js";
import type { BackdropLighting, Viewer } from "../render/Viewer.js";
import { DEATH_KNIGHT_CLASS } from "./constants.js";
import type { GameData } from "./GameData.js";

/** The scenes a character can be created in, named as `Interface\Glues\Models` names them. */
const SCENES = [
	"Human",
	"Dwarf",
	"NightElf",
	"Draenei",
	"Orc",
	"Scourge",
	"Tauren",
	"BloodElf",
	"DeathKnight",
] as const;
export type BackdropScene = (typeof SCENES)[number];

/**
 * The character-creation scene a race stands in, by `ChrRaces.clientFileString`. Gnomes share the
 * dwarf backdrop and trolls the orc one: the client ships no scene for either, and its own light
 * table is keyed the same way.
 */
const BACKDROP_BY_RACE: Record<string, BackdropScene> = {
	Human: "Human",
	Dwarf: "Dwarf",
	Gnome: "Dwarf",
	NightElf: "NightElf",
	Draenei: "Draenei",
	Orc: "Orc",
	Troll: "Orc",
	Scourge: "Scourge",
	Tauren: "Tauren",
	BloodElf: "BloodElf",
};

/** Death knights are created in Acherus whatever race they are, so the class wins over the race. */
const DEATH_KNIGHT_SCENE = "DeathKnight";

/**
 * Which of the scenes under `Interface\Glues\Models` a character is created in: Acherus for a
 * death knight, and otherwise the one for its race, named by `ChrRaces.clientFileString`. Undefined
 * for a race that is not playable and so has no scene.
 */
export function backdropScene(clientFileString: string, classId?: number): BackdropScene | undefined {
	return classId === DEATH_KNIGHT_CLASS ? DEATH_KNIGHT_SCENE : BACKDROP_BY_RACE[clientFileString];
}

/**
 * `RaceLights` from the client's `Interface\GlueXML\GlueParent.lua`, verbatim: enabled, light type,
 * the direction the light travels, then an ambient intensity with its colour and a diffuse
 * intensity with its colour. Rows with a black diffuse are the scene's ambient term and nothing
 * else. The models carry point lights of their own, which are not read.
 */
const BACKDROP_LIGHTS: Record<BackdropScene, number[][]> = {
	Human: [
		[1, 0, 0.0, 0.0, -1.0, 1.0, 0.27, 0.27, 0.27, 1.0, 0.0, 0.0, 0.0],
		[1, 0, -0.45756075, -0.58900136, -0.66611975, 1.0, 0.0, 0.0, 0.0, 1.0, 0.19882353, 0.34921569, 0.43588236],
		[1, 0, -0.64623469, 0.57582057, -0.50081086, 1.0, 0.0, 0.0, 0.0, 2.0, 0.52196085, 0.44, 0.29764709],
	],
	Orc: [
		[1, 0, 0.0, 0.0, -1.0, 1.0, 0.15, 0.15, 0.15, 1.0, 0.0, 0.0, 0.0],
		[1, 0, -0.74919, 0.35208, -0.56103, 1.0, 0.0, 0.0, 0.0, 1.0, 0.44706, 0.5451, 0.73725],
		[1, 0, 0.53162, -0.8434, 0.0778, 1.0, 0.0, 0.0, 0.0, 2.0, 0.55, 0.338625, 0.148825],
	],
	Dwarf: [
		[1, 0, -0.0, -0.0, -1.0, 1.0, 0.3, 0.3, 0.3, 0.0, 0.0, 0.0, 0.0],
		[1, 0, -0.88314, 0.42916, -0.18945, 1.0, 0.0, 0.0, 0.0, 2.0, 0.44706, 0.67451, 0.760785],
	],
	Tauren: [
		[1, 0, -0.48073, 0.71827, -0.50297, 1.0, 0.0, 0.0, 0.0, 2.0, 0.65, 0.397645, 0.2727],
		[1, 0, -0.49767, -0.78677, 0.36513, 1.0, 0.0, 0.0, 0.0, 1.0, 0.6, 0.47059, 0.32471],
	],
	Scourge: [[1, 0, 0.0, 0.0, -1.0, 1.0, 0.2, 0.2, 0.2, 1.0, 0.0, 0.0, 0.0]],
	NightElf: [[1, 0, -0.0, -0.0, -1.0, 1.0, 0.0902, 0.0902, 0.1702, 1.0, 0.0, 0.0, 0.0]],
	Draenei: [
		[1, 0, 0.61185, 0.62942, -0.47903, 1.0, 0.0, 0.0, 0.0, 1.0, 0.56941, 0.52, 0.6],
		[1, 0, -0.64345, -0.31052, -0.69968, 1.0, 0.0, 0.0, 0.0, 1.0, 0.60941, 0.60392, 0.7],
		[1, 0, -0.46481, -0.1432, 0.87376, 1.0, 0.0, 0.0, 0.0, 2.0, 0.5835, 0.48941, 0.6],
	],
	BloodElf: [
		[1, 0, -0.82249, -0.54912, -0.14822, 1.0, 0.0, 0.0, 0.0, 2.0, 0.581175, 0.50588, 0.42588],
		[1, 0, 0.0, -0.0, -1.0, 1.0, 0.60392, 0.6149, 0.7, 1.0, 0.0, 0.0, 0.0],
		[1, 0, 0.02575, 0.86518, -0.50081, 1.0, 0.0, 0.0, 0.0, 1.0, 0.59137, 0.51745, 0.63471],
	],
	DeathKnight: [[1, 0, 0.0, 0.0, -1.0, 1.0, 0.38824, 0.66353, 0.76941, 1.0, 0.0, 0.0, 0.0]],
};

/**
 * `CharModelFogInfo` from the same file: fog colour and the distance at which it is complete. The
 * draenei, blood elf and death knight scenes are listed nowhere there, and the client leaves them
 * clear.
 */
const BACKDROP_FOG: Partial<Record<BackdropScene, { color: [number, number, number]; end: number }>> = {
	Human: { color: [0.8, 0.65, 0.73], end: 222 },
	Orc: { color: [0.5, 0.5, 0.5], end: 270 },
	Dwarf: { color: [0.85, 0.88, 1.0], end: 500 },
	NightElf: { color: [0.25, 0.22, 0.55], end: 611 },
	Tauren: { color: [1.0, 0.61, 0.42], end: 153 },
	Scourge: { color: [0, 0.22, 0.22], end: 26 },
};

/** A loaded backdrop, ready for `Viewer.setBackdrop`. */
export interface Backdrop {
	instance: M2Instance;
	lighting: BackdropLighting;
}

/** Sums the ambient a scene's rows contribute and keeps the ones that also light a direction. */
function backdropLighting(name: BackdropScene): BackdropLighting {
	const rows = BACKDROP_LIGHTS[name];
	const ambient: [number, number, number] = [0, 0, 0];
	const lights: BackdropLighting["lights"] = [];
	for (const row of rows) {
		if (!row[0]) continue;
		for (let i = 0; i < 3; i++) ambient[i] += row[5] * row[6 + i];
		const color: [number, number, number] = [row[9] * row[10], row[9] * row[11], row[9] * row[12]];
		if (color.some((c) => c > 0)) lights.push({ direction: [row[2], row[3], row[4]], color });
	}
	return { ambient, lights, fog: BACKDROP_FOG[name] };
}

/** Builds the character-creation scene the client shows behind a character of a given race. */
export class BackdropBuilder {
	constructor(
		readonly assets: AssetManager,
		readonly data: GameData,
		/** The viewer's `backdropLighting`, which it fills in once the scene is in place. */
		readonly lighting: M2Lighting,
	) {}

	/**
	 * The scene for a race, or Acherus when `classId` is the death knight one. Null for a race with
	 * no scene of its own; every playable race has one.
	 */
	async build(race: number, classId?: number): Promise<Backdrop | null> {
		const name = backdropScene((await this.data.races()).get(race)?.clientFileString ?? "", classId);
		if (!name) return null;
		const model = await this.assets.loadModel(`Interface\\Glues\\Models\\UI_${name}\\UI_${name}.m2`);
		return {
			instance: await M2Instance.create(model, this.assets, this.lighting),
			lighting: backdropLighting(name),
		};
	}
}

/**
 * Loads a backdrop and puts it behind the models; the returned disposer takes it away again.
 * Separate from `mountInstance` because a backdrop is not one of the viewer's instances: it lives
 * in its own scene, out of reach of framing and the orbit controls.
 *
 * `staticCamera` (on by default) also hands the viewer over to the scene's own camera for as long as
 * the backdrop is up, which is how the character-selection screen shows it (see `Viewer.staticCamera`).
 */
export function mountBackdrop(
	viewer: Viewer,
	load: () => Promise<Backdrop | null>,
	opts: { staticCamera?: boolean; onError?: (error: unknown) => void } = {},
): () => void {
	let cancelled = false;
	let instance: M2Instance | null = null;
	// Set before the load so the models already in the scene stop orbiting right away.
	const staticCamera = opts.staticCamera ?? true;
	if (staticCamera) viewer.staticCamera = true;
	load().then(
		(backdrop) => {
			if (!backdrop) return;
			if (cancelled) return backdrop.instance.dispose();
			instance = backdrop.instance;
			viewer.setBackdrop(backdrop.instance, backdrop.lighting);
		},
		(e) => {
			if (!cancelled) opts.onError?.(e);
		},
	);
	return () => {
		cancelled = true;
		if (staticCamera) viewer.staticCamera = false;
		if (instance) {
			viewer.setBackdrop(null);
			instance.dispose();
			instance = null;
		}
	};
}
