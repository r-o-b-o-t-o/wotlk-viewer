import type { M2Instance } from "../render/M2Instance.js";
import type { CreatureFamily } from "./GameData.js";

/** A character's pet, as far as rendering one goes. */
export interface PetInfo {
	/** CreatureFamily.dbc id; 0 when it is not known. */
	family: number;
	level: number;
}

/** Half-width of a player character; the broadest races reach about this, the slimmest are not far off. */
const CHARACTER_HALF_WIDTH = 0.7;
/** Clear air left between the two models. */
const PET_GAP = 0.1;
/** How far behind the character the pet stands. */
const PET_SETBACK = 1.6;

/**
 * Where a pet stands next to its owner, in the character's own space (X forward, Y left, Z up): off
 * the left shoulder, which is screen-right with the camera in front, and a step back. The sideways
 * distance follows the pet's own bounds, so an imp comes in close and a water elemental keeps clear.
 */
export function petPosition(pet: M2Instance): [number, number, number] {
	const geometry = pet.model.geometry;
	if (!geometry.boundingBox) geometry.computeBoundingBox();
	const box = geometry.boundingBox!;
	// A bind pose splays wings or arms along one axis only (and a long body along the other), so the
	// narrower of the two is the better guess at how much room the pet takes up beside the character.
	const half = Math.min(Math.max(box.max.y, -box.min.y), Math.max(box.max.x, -box.min.x)) * pet.scale.y;
	return [-PET_SETBACK, CHARACTER_HALF_WIDTH + PET_GAP + half, 0];
}

/**
 * The size a pet of this family is drawn at: its family's scale at `minScaleLevel` growing to the
 * one at `maxScaleLevel`. This is the whole scale, not a factor on the display's — `ShowCharacter`
 * drops what `CreatureModelData` and `CreatureDisplayInfo` asked for as soon as a family answers.
 * Warlock and death knight pets have a family too, carrying the same value at both ends. Zero for
 * "Remote Control", the one family with no size of its own, which leaves the display's scale alone.
 */
export function petScale(family: CreatureFamily, level: number): number {
	const span = family.maxScaleLevel - family.minScaleLevel;
	const t = span > 0 ? Math.min(Math.max((level - family.minScaleLevel) / span, 0), 1) : 1;
	return family.minScale + t * (family.maxScale - family.minScale);
}
