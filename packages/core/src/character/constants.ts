export enum Gender {
	Male = 0,
	Female = 1,
}

/** ChrClasses id of the one class the renderer treats specially: eye glow, and its own backdrop. */
export const DEATH_KNIGHT_CLASS = 6;

/** ChrClasses id of the hunter, the one class the glue screens show holding its ranged weapon. */
export const HUNTER_CLASS = 3;

/**
 * Whether the character-selection screen draws a character's ranged weapon in place of its melee
 * ones. `ShowCharacter` skips both hand slots for a hunter and the ranged slot for everyone else,
 * so a hunter is the only one who stands there holding a bow, and never beside a sword.
 */
export function drawsRangedWeapon(classId: number | undefined): boolean {
	return classId === HUNTER_CLASS;
}

/** Character equipment slots (same numbering as the server / `character_inventory.slot`). */
export enum EquipmentSlot {
	Head = 0,
	Neck = 1,
	Shoulders = 2,
	Shirt = 3,
	Chest = 4,
	Waist = 5,
	Legs = 6,
	Feet = 7,
	Wrists = 8,
	Hands = 9,
	Finger1 = 10,
	Finger2 = 11,
	Trinket1 = 12,
	Trinket2 = 13,
	Back = 14,
	MainHand = 15,
	OffHand = 16,
	Ranged = 17,
	Tabard = 18,
}

/** Item.dbc / item_template inventory types. */
export enum InventoryType {
	NonEquip = 0,
	Head = 1,
	Neck = 2,
	Shoulders = 3,
	Shirt = 4,
	Chest = 5,
	Waist = 6,
	Legs = 7,
	Feet = 8,
	Wrists = 9,
	Hands = 10,
	Finger = 11,
	Trinket = 12,
	Weapon = 13,
	Shield = 14,
	Ranged = 15,
	Cloak = 16,
	TwoHandWeapon = 17,
	Bag = 18,
	Tabard = 19,
	Robe = 20,
	WeaponMainHand = 21,
	WeaponOffHand = 22,
	Holdable = 23,
	Ammo = 24,
	Thrown = 25,
	RangedRight = 26,
	Quiver = 27,
	Relic = 28,
}

/** M2 attachment point ids. The first five double as ItemVisual0-4 on an item model. */
export enum AttachmentId {
	Shield = 0,
	HandRight = 1,
	HandLeft = 2,
	ElbowRight = 3,
	ElbowLeft = 4,
	ShoulderRight = 5,
	ShoulderLeft = 6,
	KneeRight = 7,
	KneeLeft = 8,
	HipRight = 9,
	HipLeft = 10,
	Helm = 11,
	Back = 12,
	ShoulderFlapRight = 13,
	ShoulderFlapLeft = 14,
	ChestBloodFront = 15,
	ChestBloodBack = 16,
	Breath = 17,
	PlayerName = 18,
	Base = 19,
	Head = 20,
	SpellLeftHand = 21,
	SpellRightHand = 22,
	Special1 = 23,
	Special2 = 24,
	Special3 = 25,
	SheathMainHand = 26,
	SheathOffHand = 27,
	SheathShield = 28,
	PlayerNameMounted = 29,
	LargeWeaponLeft = 30,
	LargeWeaponRight = 31,
	HipWeaponLeft = 32,
	HipWeaponRight = 33,
	Chest = 34,
}

/** Attachments an item model carries its visual effects on, one per ItemVisuals.dbc slot. */
export const ITEM_VISUAL_ATTACHMENTS = [
	AttachmentId.Shield,
	AttachmentId.HandRight,
	AttachmentId.HandLeft,
	AttachmentId.ElbowRight,
	AttachmentId.ElbowLeft,
];

/** Character geoset groups (geoset id = group * 100 + variant). */
export enum GeosetGroup {
	Hair = 0,
	Facial1 = 1,
	Facial2 = 2,
	Facial3 = 3,
	Gloves = 4,
	Boots = 5,
	Tail = 6,
	Ears = 7,
	Sleeves = 8,
	Kneepads = 9,
	Chest = 10,
	Pants = 11,
	Tabard = 12,
	Trousers = 13,
	Unknown14 = 14,
	Cloak = 15,
	Facial4 = 16,
	EyeGlow = 17,
	Belt = 18,
}

/** CharSections.dbc base sections. */
export enum CharSectionType {
	Skin = 0,
	Face = 1,
	FacialHair = 2,
	Hair = 3,
	Underwear = 4,
}

export interface Rect {
	x: number;
	y: number;
	w: number;
	h: number;
}

/** Body texture regions, in the classic 256x256 layout (scaled to the actual skin size). */
export enum CharRegion {
	ArmUpper,
	ArmLower,
	Hand,
	FaceUpper,
	FaceLower,
	TorsoUpper,
	TorsoLower,
	PelvisUpper,
	PelvisLower,
	Foot,
}

export const CHAR_REGIONS: Record<CharRegion, Rect> = {
	[CharRegion.ArmUpper]: { x: 0, y: 0, w: 128, h: 64 },
	[CharRegion.ArmLower]: { x: 0, y: 64, w: 128, h: 64 },
	[CharRegion.Hand]: { x: 0, y: 128, w: 128, h: 32 },
	[CharRegion.FaceUpper]: { x: 0, y: 160, w: 128, h: 32 },
	[CharRegion.FaceLower]: { x: 0, y: 192, w: 128, h: 64 },
	[CharRegion.TorsoUpper]: { x: 128, y: 0, w: 128, h: 64 },
	[CharRegion.TorsoLower]: { x: 128, y: 64, w: 128, h: 32 },
	[CharRegion.PelvisUpper]: { x: 128, y: 96, w: 128, h: 64 },
	[CharRegion.PelvisLower]: { x: 128, y: 160, w: 128, h: 64 },
	[CharRegion.Foot]: { x: 128, y: 224, w: 128, h: 32 },
};

/** ItemDisplayInfo texture slots: folder under Item\TextureComponents and target region. */
export const ITEM_TEXTURE_SLOTS: { folder: string; region: CharRegion }[] = [
	{ folder: "ArmUpperTexture", region: CharRegion.ArmUpper },
	{ folder: "ArmLowerTexture", region: CharRegion.ArmLower },
	{ folder: "HandTexture", region: CharRegion.Hand },
	{ folder: "TorsoUpperTexture", region: CharRegion.TorsoUpper },
	{ folder: "TorsoLowerTexture", region: CharRegion.TorsoLower },
	{ folder: "LegUpperTexture", region: CharRegion.PelvisUpper },
	{ folder: "LegLowerTexture", region: CharRegion.PelvisLower },
	{ folder: "FootTexture", region: CharRegion.Foot },
];

/** KeyBoneLookup indices of the five finger bones of each hand, right first. */
export const FINGER_KEY_BONES: [number[], number[]] = [
	[8, 9, 10, 11, 12],
	[13, 14, 15, 16, 17],
];

/** Well-known animation ids (AnimationData.dbc). */
export const AnimationId = {
	Stand: 0,
	Death: 1,
	Spell: 2,
	Stop: 3,
	Walk: 4,
	Run: 5,
	Dead: 6,
	Rise: 7,
	StandWound: 8,
	CombatWound: 9,
	CombatCritical: 10,
	ShuffleLeft: 11,
	ShuffleRight: 12,
	WalkBackwards: 13,
	Stun: 14,
	HandsClosed: 15,
	AttackUnarmed: 16,
	Attack1H: 17,
	Attack2H: 18,
	Attack2HL: 19,
	ParryUnarmed: 20,
	Parry1H: 21,
	Parry2H: 22,
	Parry2HL: 23,
	ShieldBlock: 24,
	ReadyUnarmed: 25,
	Ready1H: 26,
	Ready2H: 27,
	Ready2HL: 28,
	ReadyBow: 29,
	Dodge: 30,
	SpellPrecast: 31,
	SpellCast: 32,
	SpellCastArea: 33,
	NPCWelcome: 34,
	NPCGoodbye: 35,
	Block: 36,
	JumpStart: 37,
	Jump: 38,
	JumpEnd: 39,
	Fall: 40,
	SwimIdle: 41,
	Swim: 42,
	SwimLeft: 43,
	SwimRight: 44,
	SwimBackwards: 45,
	AttackBow: 46,
	FireBow: 47,
	ReadyRifle: 48,
	AttackRifle: 49,
	Loot: 50,
	ReadySpellDirected: 51,
	ReadySpellOmni: 52,
	SpellCastDirected: 53,
	SpellCastOmni: 54,
	BattleRoar: 55,
	ReadyAbility: 56,
	Special1H: 57,
	Special2H: 58,
	ShieldBash: 59,
	EmoteTalk: 60,
	EmoteEat: 61,
	EmoteWork: 62,
	EmoteUseStanding: 63,
	EmoteTalkExclamation: 64,
	EmoteTalkQuestion: 65,
	EmoteBow: 66,
	EmoteWave: 67,
	EmoteCheer: 68,
	EmoteDance: 69,
	EmoteLaugh: 70,
	EmoteSleep: 71,
	EmoteSitGround: 72,
	EmoteRude: 73,
	EmoteRoar: 74,
	EmoteKneel: 75,
	EmoteKiss: 76,
	EmoteCry: 77,
	EmoteChicken: 78,
	EmoteBeg: 79,
	EmoteApplaud: 80,
	EmoteShout: 81,
	EmoteFlex: 82,
	EmoteShy: 83,
	EmotePoint: 84,
} as const;
