import { beforeAll, describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { readTrackKeys } from "../animation/tracks.js";
import { parseM2 } from "./m2.js";
import { parseSkin } from "./skin.js";
import { parseBlp } from "./blp.js";
import { Dbc } from "./dbc.js";

// Tests run against a real extracted client (WOW_CLIENT_DIR in .env); skipped when it is absent.
const CLIENT = process.env.WOW_CLIENT_DIR ?? "";
const hasClient = CLIENT !== "" && existsSync(join(CLIENT, "Data/Character/Human/Male/HumanMale.M2"));

const read = (p: string): ArrayBuffer => {
	const b = readFileSync(join(CLIENT, p));
	return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
};

describe.skipIf(!hasClient)("M2 / SKIN parsing", () => {
	// Loaded in beforeAll, which a skipped suite never runs; a describe body always runs.
	let m2: ReturnType<typeof parseM2>;
	let skin: ReturnType<typeof parseSkin>;
	beforeAll(() => {
		m2 = parseM2(read("Data/Character/Human/Male/HumanMale.M2"));
		skin = parseSkin(read("Data/Character/Human/Male/HumanMale00.skin"));
	});

	it("reads the header", () => {
		expect(m2.name).toBe("HumanMale");
		expect(m2.sequences.length).toBe(156);
		expect(m2.bones.length).toBe(138);
		expect(m2.globalLoops.length).toBe(3);
		expect(m2.vertices.count).toBeGreaterThan(5000);
		expect(m2.textures.length).toBeGreaterThan(0);
		expect(m2.materials.length).toBeGreaterThan(0);
	});

	it("reads plausible sequences and bones", () => {
		const stand = m2.sequences[0];
		expect(stand.id).toBe(0);
		expect(stand.duration).toBeGreaterThan(0);
		for (const s of m2.sequences) {
			expect(s.duration).toBeLessThan(600000);
			expect(s.aliasNext).toBeLessThan(m2.sequences.length);
		}
		for (let i = 0; i < m2.bones.length; i++) {
			const b = m2.bones[i];
			expect(b.parentBone).toBeGreaterThanOrEqual(-1);
			expect(b.parentBone).toBeLessThan(i); // parents precede children
			expect(
				b.translation.timestamps.length === 0 || b.translation.timestamps.length === m2.sequences.length,
			).toBe(true);
			for (const c of b.pivot) expect(Math.abs(c)).toBeLessThan(10);
		}
		expect(m2.sequenceLookup[0]).toBe(0);
	});

	it("reads vertices in a sane range", () => {
		const p = m2.vertices.positions;
		for (let i = 0; i < p.length; i++) expect(Math.abs(p[i])).toBeLessThan(10);
		for (let i = 0; i < m2.vertices.count; i++) {
			let w = 0;
			for (let k = 0; k < 4; k++) w += m2.vertices.boneWeights[i * 4 + k];
			expect(w).toBe(255);
			for (let k = 0; k < 4; k++) expect(m2.vertices.boneIndices[i * 4 + k]).toBeLessThan(m2.bones.length);
		}
	});

	it("reads attachments and textures", () => {
		expect(m2.attachments.length).toBeGreaterThan(10);
		for (const a of m2.attachments) expect(a.bone).toBeLessThan(m2.bones.length);
		expect(m2.textures.some((t) => t.type === 1)).toBe(true); // body skin slot
		expect(m2.textures.some((t) => t.type === 6)).toBe(true); // hair slot
	});

	it("reads the cameras a character is shown through", () => {
		// The pair every character model carries: a portrait framing the head, and the character tab.
		expect(m2.cameras.map((c) => c.type)).toEqual([0, 1]);
		for (const c of m2.cameras) {
			expect(c.fov).toBeGreaterThan(0);
			expect(c.nearClip).toBeLessThan(c.farClip);
		}
		expect(m2.cameras[0].target[2]).toBeGreaterThan(1.5); // head height
	});

	it("reads the camera a glue backdrop is composed around", () => {
		const backdrop = parseM2(read("Data_enUS/Interface/Glues/Models/UI_Human/UI_Human.m2"));
		expect(backdrop.cameras.length).toBe(1);
		const cam = backdrop.cameras[0];
		expect((cam.fov * 180) / Math.PI).toBeCloseTo(80);
		expect(cam.farClip).toBeCloseTo(611.111, 2);
		// Both sit inside the scene, which is modelled a long way off the origin.
		expect(cam.position.map(Math.round)).toEqual([-222, -82, -2]);
		expect(cam.target.map(Math.round)).toEqual([-230, -79, -2]);
	});

	it("reads the lights a glue backdrop lights itself with", () => {
		const backdrop = parseM2(read("Data_enUS/Interface/Glues/Models/UI_NightElf/UI_NightElf.m2"));
		expect(backdrop.lights.map((l) => l.type)).toEqual([1, 1, 0, 1]);
		for (const l of backdrop.lights) expect(l.bone).toBeLessThan(backdrop.bones.length);
		// The bright one sits in the moonwell, whose geometry centres on (-25.7, -6.0, 1.2).
		const well = backdrop.lights[0];
		expect(well.position.map(Math.round)).toEqual([-23, -5, 2]);
		const keys = (t: (typeof well)["diffuseColor"], kind: "vec3" | "float") =>
			readTrackKeys(backdrop.reader, t, 0, kind)!.values;
		expect([...keys(well.diffuseColor, "vec3")].map((v) => +v.toFixed(2))).toEqual([0.32, 0.58, 0.54]);
		expect(keys(well.diffuseIntensity, "float")[0]).toBeCloseTo(13);
		// The only directional entry repeats what RaceLights gives the night elf scene as its ambient.
		const ambient = backdrop.lights[2];
		expect([...keys(ambient.ambientColor, "vec3")].map((v) => +v.toFixed(2))).toEqual([0.45, 0.45, 0.85]);
		expect(keys(ambient.ambientIntensity, "float")[0]).toBeCloseTo(0.2);
		expect(keys(ambient.diffuseIntensity, "float")[0]).toBe(0);
	});

	it("reads the skin profile", () => {
		expect(skin.submeshes.length).toBe(61);
		expect(skin.batches.length).toBe(61);
		expect(skin.submeshes[0].id).toBe(0);
		expect(skin.indices.length % 3).toBe(0);
		for (const i of skin.indices) expect(i).toBeLessThan(skin.vertices.length);
		for (const v of skin.vertices) expect(v).toBeLessThan(m2.vertices.count);
		for (const b of skin.batches) {
			expect(b.submeshIndex).toBeLessThan(skin.submeshes.length);
			expect(b.materialIndex).toBeLessThan(m2.materials.length);
			expect(b.textureComboIndex + b.textureCount).toBeLessThanOrEqual(m2.textureLookup.length);
		}
	});
});

describe.skipIf(!hasClient)("BLP decoding", () => {
	it("decodes a body skin", () => {
		const img = parseBlp(read("Data/Character/Human/Male/HumanMaleSkin00_00.blp"));
		expect(img.width).toBe(512);
		expect(img.height).toBe(512);
		expect(img.data.length).toBe(512 * 512 * 4);
		// skin tone: reddish, not black
		let sum = 0;
		for (let i = 0; i < img.data.length; i += 4) sum += img.data[i];
		expect(sum / (img.width * img.height)).toBeGreaterThan(60);
	});

	it("decodes an item texture with alpha", () => {
		const img = parseBlp(read("Data/ITEM/TEXTURECOMPONENTS/TorsoUpperTexture/Cloth_A_01Black_Chest_TU_M.blp"));
		expect(img.width).toBeGreaterThan(0);
		expect(img.height).toBeGreaterThan(0);
	});
});

describe.skipIf(!hasClient)("DBC parsing", () => {
	it("reads ChrRaces", () => {
		const dbc = new Dbc(read("Data_enUS/DBFilesClient/ChrRaces.dbc"));
		expect(dbc.fieldCount).toBe(69);
		expect(dbc.uint(0, 0)).toBe(1);
		expect(dbc.string(0, 6)).toBe("Hu");
		expect(dbc.string(0, 14)).toBe("Human");
	});
});
