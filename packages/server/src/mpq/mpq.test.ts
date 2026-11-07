import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { archiveChain } from "./chain.js";
import { MpqArchive } from "./Archive.js";
import { explode } from "./explode.js";
import { detectLocale, extractClient } from "./extractClient.js";

describe("explode", () => {
	it("decodes the reference DCL stream", () => {
		// blast.c ships this stream as its own test; no archive in a 3.3.5a client uses PKWARE, so
		// without it the decoder would go out the door unexercised.
		const input = Buffer.from([0x00, 0x04, 0x82, 0x24, 0x25, 0x8f, 0x80, 0x7f]);
		expect(explode(input, 13).toString("latin1")).toBe("AIAIAIAIAIAIA");
	});
});

describe("extractClient", () => {
	it("refuses to write into the client install itself", async () => {
		const dir = "C:/Games/WoW";
		await expect(extractClient({ clientDir: dir, outDir: `${dir}/../WoW` })).rejects.toThrow(
			/must not be the client install/,
		);
	});
});

// The client install sits beside the extract WOW_CLIENT_DIR points at; skipped when it is absent.
const CLIENT = process.env.WOW_CLIENT_DIR ? dirname(process.env.WOW_CLIENT_DIR) : "";
const DATA = CLIENT && join(CLIENT, "Data");
const hasClient = DATA !== "" && existsSync(DATA);

describe.skipIf(!hasClient)("MPQ archive chain", () => {
	it("orders archives the way the client searches them", async () => {
		const locale = await detectLocale(DATA);
		expect(locale).toMatch(/^[a-z]{4}$/i);
		const names = (await archiveChain(DATA, locale)).map((e) => basename(e.path).toLowerCase());

		// Patches outrank the base archives, highest-numbered first, and a locale patch sits just
		// under the base patch of the same number.
		expect(names.indexOf("patch-3.mpq")).toBeLessThan(names.indexOf("patch-2.mpq"));
		expect(names.indexOf("patch-2.mpq")).toBeLessThan(names.indexOf("patch.mpq"));
		expect(names.indexOf("patch.mpq")).toBeLessThan(names.indexOf("common-2.mpq"));
		expect(names.indexOf("common.mpq")).toBeLessThan(names.indexOf("common-2.mpq"));
		expect(names.indexOf(`locale-${locale.toLowerCase()}.mpq`)).toBeGreaterThan(names.indexOf("common-2.mpq"));
		// The installer's own archives are not in the chain.
		expect(names).not.toContain(`base-${locale.toLowerCase()}.mpq`);
	});

	it("reads the patched copy of a file both patch and common hold", async () => {
		const locale = await detectLocale(DATA);
		const chain = await archiveChain(DATA, locale);
		const path = "Item/ObjectComponents/Weapon/Sword_1H_Nexus_D_03.M2";

		const sizes = new Map<string, number>();
		for (const entry of chain) {
			const archive = await MpqArchive.open(entry.path);
			try {
				if (!archive.has(path)) continue;
				const data = (await archive.read(path))!;
				// Decompressed, not merely the right length: a wrong codec still fills the buffer.
				expect(data.subarray(0, 4).toString("latin1")).toBe("MD20");
				sizes.set(basename(entry.path).toLowerCase(), data.length);
			} finally {
				await archive.close();
			}
		}

		// Hailstorm's blade: common-2 has the pre-patch model, patch.MPQ the one with the emitter that
		// lights its centre. Walking the archives in directory order picks the wrong one.
		expect(sizes.get("common-2.mpq")).toBe(32608);
		expect(sizes.get("patch.mpq")).toBe(36432);
		const first = chain.map((e) => basename(e.path).toLowerCase()).find((n) => sizes.has(n));
		expect(first).toBe("patch.mpq");
	});
});
