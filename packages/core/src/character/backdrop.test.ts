import { describe, expect, it } from "vitest";
import { backdropLighting } from "./backdrop.js";

/**
 * The fold is pure arithmetic over the light table, so it runs without a client. The numbers below
 * come from the client's own formula, applied by hand to the rows each scene lists.
 */
describe("backdrop lighting", () => {
	it("folds a scene's lights into one sun", () => {
		// Orc: a grey ambient row, a blue light and a warm one at double intensity. The sun ends up
		// warm, since the two directions largely oppose each other and the warm one weighs more.
		const { ambient, lights } = backdropLighting("Orc");
		expect(lights).toHaveLength(1);
		expect(lights[0].direction.map(round)).toEqual([-0.02, -0.871, -0.49]);
		expect(lights[0].color.map(round)).toEqual([0.547, 0.264, -0.019]);
		// 0.15 grey, plus the quarter of each light the sun's direction misses.
		expect(ambient.map(round)).toEqual([0.35, 0.342, 0.361]);
	});

	it("keeps a single light as it stands", () => {
		// One light is already its own sun: the fold moves nothing to ambient and leaves the colour
		// as it is, bar the clamp that takes its green and blue down to 1.
		const { ambient, lights } = backdropLighting("Dwarf");
		expect(lights[0].direction.map(round)).toEqual([-0.883, 0.429, -0.189]);
		expect(lights[0].color.map(round)).toEqual([0.894, 1, 1]);
		expect(ambient.map(round)).toEqual([0.3, 0.3, 0.3]);
	});

	it("leaves a scene lit by ambient alone without a sun", () => {
		const { ambient, lights } = backdropLighting("Scourge");
		expect(lights).toEqual([]);
		expect(ambient.map(round)).toEqual([0.2, 0.2, 0.2]);
	});
});

/** Three decimals: finer than the byte the client rounds a light's colour to. */
const round = (n: number) => Math.round(n * 1e3) / 1e3;
