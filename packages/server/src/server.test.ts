import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { AssetManager, CharSectionType, GameData, Gender } from "@wotlk-viewer/core";
import { FsDataSource } from "./FsDataSource";
import { defaultRoots, FileResolver } from "./files";

const CLIENT = process.env.WOW_CLIENT_DIR ?? "C:/Games/WoW/WoW_335a_Clean/Extracted";
const hasClient = existsSync(CLIENT);

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

	it("resolves items to display info", async () => {
		const data = await load();
		const item = (await data.items()).get(40421);
		expect(item?.displayId).toBe(55167);
		const display = (await data.itemDisplayInfo()).get(55167);
		expect(display?.leftModel).toMatch(/\.mdx$/i);
		expect((await data.animationNames()).get(0)).toBe("Stand");
	});
});
