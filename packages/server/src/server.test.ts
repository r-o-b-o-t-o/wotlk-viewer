import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { AssetManager, backdropScene, CharSectionType, GameData, Gender, petScale } from "@wotlk-viewer/core";
import { FsDataSource } from "./FsDataSource.js";
import { defaultRoots, FileResolver } from "./files.js";

const CLIENT = process.env.WOW_CLIENT_DIR ?? "";
const hasClient = CLIENT !== "" && existsSync(CLIENT);

describe.skipIf(!hasClient)("FileResolver", () => {
	it("resolves paths case-insensitively across roots", async () => {
		const resolver = new FileResolver(await defaultRoots(CLIENT));
		expect(await resolver.resolve("character\\HUMAN\\male\\humanmale.M2")).toMatch(/HumanMale\.M2$/);
		expect(await resolver.resolve("DBFilesClient/chrraces.dbc")).toMatch(/ChrRaces\.dbc$/);
		expect(await resolver.resolve("does/not/exist.blp")).toBeNull();
		expect(await resolver.resolve("../package.json")).toBeNull();
	});
});

describe.skipIf(!hasClient)("M2Model", () => {
	it("draws translucent batches in priority-plane order", async () => {
		const assets = new AssetManager(await FsDataSource.fromClientDir(CLIENT));
		const model = await assets.loadModel("Interface/Glues/Models/UI_DeathKnight/UI_DeathKnight.m2");
		const plane = (batch: number) => model.skin.batches[batch].priorityPlane;
		const order = model.geometry.groups.map((g) => g.materialIndex ?? 0);
		expect(new Set(order.map(plane)).size).toBeGreaterThan(1); // or the check below proves nothing
		// Acherus hangs its Icecrown sky bowl on plane 0 and the mountains inside it on 9. Taken in
		// file order the bowl lands on top of them, as a dark band across the sky.
		for (let i = 1; i < order.length; i++) expect(plane(order[i])).toBeGreaterThanOrEqual(plane(order[i - 1]));
	});
});

describe.skipIf(!hasClient)("GameData", () => {
	const load = async () => new GameData(new AssetManager(await FsDataSource.fromClientDir(CLIENT)));

	it("maps races to character models", async () => {
		const data = await load();
		expect(await data.characterModelPath(1, Gender.Male)).toBe("Character\\Human\\Male\\HumanMale.mdx");
		expect(await data.characterModelPath(10, Gender.Female)).toBe(
			"Character\\BloodElf\\Female\\BloodElfFemale.mdx",
		);
		expect((await data.races()).get(4)?.clientPrefix).toBe("Ni");
	});

	it("reads character sections and customization options", async () => {
		const data = await load();
		const skin = await data.findCharSection(1, 0, CharSectionType.Skin, 0, 0);
		expect(skin?.textures[0]).toBe("Character\\Human\\Male\\HumanMaleSkin00_00.blp");
		const hair = await data.findHairGeoset(1, 0, 1);
		expect(hair?.geoset).toBe(2);
		const opts = await data.customizationOptions(1, 0);
		expect(opts.skins.length).toBeGreaterThan(5);
		expect(opts.hairStyles).toContain(0);
		expect(opts.faces.length).toBeGreaterThan(5);
	});

	it("finds a hair texture for a bald style, which facial hair needs", async () => {
		const data = await load();
		// Gnome male style 0 is bald and carries no sheet, but its beard samples the hair slot.
		const bald = await data.findCharSection(7, 0, CharSectionType.Hair, 0, 0);
		expect(bald?.textures[0]).toBe("");
		expect(await data.findHairTexture(7, 0, 0)).toBe("Character\\Gnome\\Hair00_00.blp");
		expect(await data.findHairTexture(7, 0, 3)).toBe("Character\\Gnome\\Hair00_03.blp");
	});

	it("sizes a pet from its creature family", async () => {
		const data = await load();
		const moth = (await data.creatureFamilies()).get(37)!;
		expect(moth.name).toBe("Moth");
		// 0.35 at level 1 growing to 0.65 at level 60, which is why a fresh moth is not NPC-sized.
		expect(petScale(moth, 1)).toBeCloseTo(0.35);
		expect(petScale(moth, 60)).toBeCloseTo(0.65);
		expect(petScale(moth, 80)).toBeCloseTo(0.65);
		// Warlock pets carry one flat size at both ends.
		const imp = (await data.creatureFamilies()).get(23)!;
		expect([petScale(imp, 1), petScale(imp, 80)]).toEqual([0.5, 0.5]);
		// The family's size is the whole scale, uncapped: the client drops the display's as soon as a
		// family answers, so a grown crab really is drawn at 1.4.
		const crab = (await data.creatureFamilies()).get(8)!;
		expect(crab.maxScale).toBeCloseTo(1.4);
		expect(petScale(crab, 80)).toBeCloseTo(1.4);
		// "Remote Control" carries no size of its own, and leaves the display's scale alone.
		expect(petScale((await data.creatureFamilies()).get(28)!, 80)).toBe(0);
	});

	it("has a character-creation backdrop for every playable race", async () => {
		const races = await (await load()).races();
		const scene = (id: number, classId?: number) => backdropScene(races.get(id)!.clientFileString, classId);
		const playable = [1, 2, 3, 4, 5, 6, 7, 8, 10, 11];
		expect([...new Set(playable.map((id) => scene(id)))].sort()).toEqual([
			"BloodElf",
			"Draenei",
			"Dwarf",
			"Human",
			"NightElf",
			"Orc",
			"Scourge",
			"Tauren",
		]);
		// The two races the client gives no scene of their own.
		expect(scene(7)).toBe("Dwarf");
		expect(scene(8)).toBe("Orc");
		// A death knight is created in Acherus whatever race it is.
		expect(scene(7, 6)).toBe("DeathKnight");
		expect(scene(11, 6)).toBe("DeathKnight");
		expect(backdropScene("Naga_")).toBeUndefined();
	});

	it("resolves items to display info", async () => {
		const data = await load();
		const item = (await data.items()).get(40421);
		expect(item?.displayId).toBe(55167);
		const display = (await data.itemDisplayInfo()).get(55167);
		expect(display?.leftModel).toMatch(/\.mdx$/i);
		expect((await data.animationNames()).get(0)).toBe("Stand");
	});
});
