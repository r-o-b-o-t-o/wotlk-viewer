import mysql, { type Pool, type RowDataPacket } from "mysql2/promise";

export interface DbOptions {
	host?: string;
	port?: number;
	user: string;
	password: string;
	/** AzerothCore characters database. */
	database: string;
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

export interface CharacterDetails extends CharacterSummary {
	skin: number;
	face: number;
	hairStyle: number;
	hairColor: number;
	facialStyle: number;
	equipment: EquippedItem[];
}

/** Read-only access to player characters and their equipped items. */
export class CharacterDb {
	private readonly pool: Pool;
	private transmog: Promise<boolean> | null = null;

	constructor(opts: DbOptions) {
		this.pool = mysql.createPool({
			host: opts.host ?? "localhost",
			port: opts.port ?? 3306,
			user: opts.user,
			password: opts.password,
			database: opts.database,
			connectionLimit: 4,
		});
	}

	async search(namePrefix: string, limit = 20): Promise<CharacterSummary[]> {
		const [rows] = await this.pool.query<RowDataPacket[]>(
			"SELECT guid, name, race, class, gender, level FROM characters WHERE name LIKE ? AND deleteDate IS NULL ORDER BY name LIMIT ?",
			[`${namePrefix}%`, Math.min(limit, 100)],
		);
		return rows as CharacterSummary[];
	}

	async get(guid: number): Promise<CharacterDetails | null> {
		const [rows] = await this.pool.query<RowDataPacket[]>(
			"SELECT guid, name, race, class, gender, level, skin, face, hairStyle, hairColor, facialStyle FROM characters WHERE guid = ?",
			[guid],
		);
		const c = rows[0];
		if (!c) return null;
		const transmog = await this.hasTransmog();
		const [items] = await this.pool.query<RowDataPacket[]>(
			`SELECT ci.slot, ii.itemEntry, ii.enchantments${transmog ? ", ct.FakeEntry" : ""}
       FROM character_inventory ci JOIN item_instance ii ON ii.guid = ci.item
       ${transmog ? "LEFT JOIN custom_transmogrification ct ON ct.GUID = ci.item" : ""}
       WHERE ci.guid = ? AND ci.bag = 0 AND ci.slot < 19 ORDER BY ci.slot`,
			[guid],
		);
		return {
			...(c as CharacterSummary),
			skin: c.skin,
			face: c.face,
			hairStyle: c.hairStyle,
			hairColor: c.hairColor,
			facialStyle: c.facialStyle,
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

	close(): Promise<void> {
		return this.pool.end();
	}
}
