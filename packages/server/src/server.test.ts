import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { AssetManager, BACKDROP_SCENES, CharSectionType, GameData, Gender, petScale } from "@wotlk-viewer/core";
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

	it("sizes a tamed pet from its creature family", async () => {
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
		// The crab is the one family whose DBC size runs over the 1.0 cap.
		const crab = (await data.creatureFamilies()).get(8)!;
		expect(crab.maxScale).toBeCloseTo(1.4);
		expect(petScale(crab, 80)).toBe(1);
	});

	it("has a character-creation backdrop for every playable race", async () => {
		const races = await (await load()).races();
		for (const id of [1, 2, 3, 4, 5, 6, 7, 8, 10, 11]) {
			expect(BACKDROP_SCENES[races.get(id)!.clientFileString]).toBeTruthy();
		}
		// The two races the client gives no scene of their own.
		expect(BACKDROP_SCENES.Gnome).toBe("Dwarf");
		expect(BACKDROP_SCENES.Troll).toBe("Orc");
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
