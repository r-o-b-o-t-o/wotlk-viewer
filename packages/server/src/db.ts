import mysql, { type Pool, type RowDataPacket } from "mysql2/promise";

export interface DbOptions {
	host?: string;
	port?: number;
	user: string;
	password: string;
	/** AzerothCore characters database. */
	database: string;
	/**
	 * AzerothCore world database, read only for the `creature_template.family` that sizes a pet.
	 * Defaults to `database` with a `_characters` suffix swapped for `_world`, and the lookup is
	 * skipped when there is no such database.
	 */
	worldDatabase?: string;
}

export interface CharacterSummary {
	guid: number;
	name: string;
	race: number;
	class: number;
	gender: number;
	level: number;
}

export interface EquippedItem {
	/** Equipment slot (0 head ... 18 tabard). */
	slot: number;
	itemEntry: number;
	/** Permanent enchant id, if any. */
	enchant: number;
	/** mod-transmog appearance to show instead, when the module is installed and one is applied. */
	transmogEntry?: number;
	/** mod-transmog hides this slot's appearance. */
	transmogHidden?: boolean;
}

/** mod-transmog stores this entry to mean "hide this item" rather than an appearance. */
const TRANSMOG_HIDDEN = 1;

/** Death knights are left out: every one of them carries the same ghoul. */
const DEATH_KNIGHT = 6;

/** The pet a character currently has out; the other `character_pet` rows are stabled. */
export interface CharacterPet {
	/** creature_template id. */
	entry: number;
	/** CreatureDisplayInfo id, as sent to the client. */
	displayId: number;
	name: string;
	level: number;
	/** CreatureFamily.dbc id, which is what sizes a tamed pet; 0 without the world database. */
	family: number;
	/** A tamed hunter pet, as opposed to a summon. */
	tamed: boolean;
}

/** `character_pet.PetType` of a tamed hunter pet; 0 is a summon. */
const HUNTER_PET = 1;

/** `characters.playerFlags` bits for the two pieces of gear a player can turn off. */
const PLAYER_FLAGS_HIDE_HELM = 0x400;
const PLAYER_FLAGS_HIDE_CLOAK = 0x800;

/** Guild membership; the emblem fields are what a guild tabard is painted with. */
export interface CharacterGuild {
	id: number;
	name: string;
	emblemStyle: number;
	emblemColor: number;
	borderStyle: number;
	borderColor: number;
	backgroundColor: number;
}

export interface CharacterDetails extends CharacterSummary {
	skin: number;
	face: number;
	hairStyle: number;
	hairColor: number;
	facialStyle: number;
	/** The character turned their helm off; the rest of `playerFlags` is none of a viewer's business. */
	hideHelm: boolean;
	/** The character turned their cloak off. */
	hideCloak: boolean;
	equipment: EquippedItem[];
	guild?: CharacterGuild;
	/** Active pet, for the classes that have one. */
	pet?: CharacterPet;
}

/** Read-only access to player characters and their equipped items. */
export class CharacterDb {
	private readonly pool: Pool;
	private transmog: Promise<boolean> | null = null;
	private world: Promise<string | null> | null = null;
	/** Interpolated into SQL, so it is only kept when it is a plain identifier. */
	private readonly worldName: string | null;

	constructor(opts: DbOptions) {
		this.pool = mysql.createPool({
			host: opts.host ?? "localhost",
			port: opts.port ?? 3306,
			user: opts.user,
			password: opts.password,
			database: opts.database,
			connectionLimit: 4,
		});
		const world = opts.worldDatabase ?? opts.database.replace(/_characters$/, "_world");
		this.worldName = world !== opts.database && /^\w+$/.test(world) ? world : null;
	}

	async search(namePrefix: string, limit = 20): Promise<CharacterSummary[]> {
		const [rows] = await this.pool.query<RowDataPacket[]>(
			"SELECT guid, name, race, class, gender, level FROM characters WHERE name LIKE ? AND deleteDate IS NULL ORDER BY name LIMIT ?",
			[`${namePrefix}%`, Math.min(limit, 100)],
		);
		return rows as CharacterSummary[];
	}

	async get(guid: number): Promise<CharacterDetails | null> {
		const [transmog, world] = await Promise.all([this.hasTransmog(), this.worldDatabase()]);
		const [rows] = await this.pool.query<RowDataPacket[]>(
			`SELECT c.guid, c.name, c.race, c.class, c.gender, c.level, c.skin, c.face, c.hairStyle, c.hairColor,
              c.facialStyle, c.playerFlags, g.guildid, g.name AS guildName,
              g.EmblemStyle, g.EmblemColor, g.BorderStyle, g.BorderColor, g.BackgroundColor,
              cp.entry AS petEntry, cp.modelid AS petModelId, cp.name AS petName, cp.level AS petLevel,
              cp.PetType AS petType${world ? ", ct.family AS petFamily" : ""}
       FROM characters c
       LEFT JOIN guild_member gm ON gm.guid = c.guid
       LEFT JOIN guild g ON g.guildid = gm.guildid
       LEFT JOIN character_pet cp ON cp.owner = c.guid AND cp.slot = 0
       ${world ? `LEFT JOIN \`${world}\`.creature_template ct ON ct.entry = cp.entry` : ""}
       WHERE c.guid = ?`,
			[guid],
		);
		const c = rows[0];
		if (!c) return null;
		const [items] = await this.pool.query<RowDataPacket[]>(
			`SELECT ci.slot, ii.itemEntry, ii.enchantments${transmog ? ", ct.FakeEntry" : ""}
       FROM character_inventory ci JOIN item_instance ii ON ii.guid = ci.item
       ${transmog ? "LEFT JOIN custom_transmogrification ct ON ct.GUID = ci.item" : ""}
       WHERE ci.guid = ? AND ci.bag = 0 AND ci.slot < 19 ORDER BY ci.slot`,
			[guid],
		);
		return {
			guid: c.guid,
			name: c.name,
			race: c.race,
			class: c.class,
			gender: c.gender,
			level: c.level,
			skin: c.skin,
			face: c.face,
			hairStyle: c.hairStyle,
			hairColor: c.hairColor,
			facialStyle: c.facialStyle,
			hideHelm: (c.playerFlags & PLAYER_FLAGS_HIDE_HELM) !== 0,
			hideCloak: (c.playerFlags & PLAYER_FLAGS_HIDE_CLOAK) !== 0,
			guild: c.guildid
				? {
						id: c.guildid,
						name: c.guildName,
						emblemStyle: c.EmblemStyle,
						emblemColor: c.EmblemColor,
						borderStyle: c.BorderStyle,
						borderColor: c.BorderColor,
						backgroundColor: c.BackgroundColor,
					}
				: undefined,
			pet:
				c.petModelId && c.class !== DEATH_KNIGHT
					? {
							entry: c.petEntry,
							displayId: c.petModelId,
							name: c.petName,
							level: c.petLevel,
							family: Number(c.petFamily) || 0,
							tamed: c.petType === HUNTER_PET,
						}
					: undefined,
			equipment: items.map((i) => {
				const fake = Number(i.FakeEntry) || 0;
				return {
					slot: i.slot,
					itemEntry: i.itemEntry,
					// "id duration charges" triplets; slot 0 is the permanent enchant.
					enchant: Number(String(i.enchantments ?? "").split(" ")[0]) || 0,
					transmogEntry: fake > TRANSMOG_HIDDEN ? fake : undefined,
					transmogHidden: fake === TRANSMOG_HIDDEN || undefined,
				};
			}),
		};
	}

	/** mod-transmog is optional, so probe its table once and remember the answer. */
	private hasTransmog(): Promise<boolean> {
		return (this.transmog ??= this.pool
			.query<RowDataPacket[]>(
				`SELECT 1 FROM information_schema.tables
         WHERE table_schema = DATABASE() AND table_name = 'custom_transmogrification' LIMIT 1`,
			)
			.then(([rows]) => rows.length > 0)
			.catch((e) => {
				console.warn(`Could not check for mod-transmog: ${e instanceof Error ? e.message : e}`);
				return false;
			}));
	}

	/**
	 * Name of the world database once it is known to hold `creature_template`, else null. Optional
	 * like mod-transmog, so it is probed once and remembered.
	 */
	private worldDatabase(): Promise<string | null> {
		return (this.world ??= this.probeWorldDatabase());
	}

	private async probeWorldDatabase(): Promise<string | null> {
		if (!this.worldName) return null;
		try {
			const [rows] = await this.pool.query<RowDataPacket[]>(
				`SELECT 1 FROM information_schema.tables
         WHERE table_schema = ? AND table_name = 'creature_template' LIMIT 1`,
				[this.worldName],
			);
			return rows.length > 0 ? this.worldName : null;
		} catch (e) {
			console.warn(`Could not reach the world database: ${e instanceof Error ? e.message : e}`);
			return null;
		}
	}

	close(): Promise<void> {
		return this.pool.end();
	}
}
