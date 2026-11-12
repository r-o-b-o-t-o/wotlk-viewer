import {
	createDeferred,
	createEffect,
	createMemo,
	createSignal,
	createStore,
	For,
	reconcile,
	Show,
	untrack,
} from "solid-js";
import type { JSX } from "@solidjs/web";
import {
	AssetManager,
	BACKDROP_CHARACTER_ATTACHMENT,
	BACKDROP_PET_ATTACHMENT,
	drawsRangedWeapon,
	EquipmentSlot,
	GameData,
	HttpDataSource,
	petPosition,
	type CharacterAppearance,
	type CharacterItem,
	type ChrRace,
	type CustomizationOptions,
	type ItemAppearance,
	type M2Instance,
} from "@roboto_/wotlk-viewer-core";
import { Backdrop, Character, Creature, Item, Model, WowViewer } from "@roboto_/wotlk-viewer-solid";
// Type-only, so the server package is erased from the browser bundle.
import type { CharacterDetails, CharacterSummary } from "@roboto_/wotlk-viewer-server";

const assets = new AssetManager(new HttpDataSource("/data"));
const gameData = new GameData(assets);

const PLAYABLE_RACES = [1, 2, 3, 4, 5, 6, 7, 8, 10, 11];
const VISUAL_SLOTS: [EquipmentSlot, string][] = [
	[EquipmentSlot.Head, "Head"],
	[EquipmentSlot.Shoulders, "Shoulders"],
	[EquipmentSlot.Back, "Back"],
	[EquipmentSlot.Chest, "Chest"],
	[EquipmentSlot.Shirt, "Shirt"],
	[EquipmentSlot.Tabard, "Tabard"],
	[EquipmentSlot.Wrists, "Wrists"],
	[EquipmentSlot.Hands, "Hands"],
	[EquipmentSlot.Waist, "Waist"],
	[EquipmentSlot.Legs, "Legs"],
	[EquipmentSlot.Feet, "Feet"],
	[EquipmentSlot.MainHand, "Main hand"],
	[EquipmentSlot.OffHand, "Off hand"],
	[EquipmentSlot.Ranged, "Ranged"],
];
const MODELS = [
	"Character\\Human\\Male\\HumanMale.m2",
	"Creature\\Murloc\\Murloc.m2",
	"Creature\\Kodobeast\\KodoBeast.m2",
	"Item\\ObjectComponents\\Weapon\\Sword_1H_Ashbringer_D_01.m2",
];

type Mode = "character" | "model" | "creature" | "item";

/**
 * Shallow-merges `patch` into a store draft. Objects and arrays are reconciled into the ones already there,
 * so an unchanged guild emblem or equipment list (keyed by slot) does not re-run its readers.
 */
function mergeInto<T extends object>(draft: T, patch: Partial<T>): void {
	const target = draft as Record<string, unknown>;
	for (const [key, value] of Object.entries(patch)) {
		if (value && typeof value === "object" && target[key] && typeof target[key] === "object")
			reconcile(value, "slot")(target[key]);
		else target[key] = value;
	}
}

/**
 * Empty on any failure: a rejected search has no `<Errored>` to land in and would halt the app.
 * Without a database the API is absent and the dev server answers with its HTML page.
 */
async function searchCharacters(name: string): Promise<CharacterSummary[]> {
	const res = await fetch(`/api/characters?name=${encodeURIComponent(name)}&limit=30`);
	if (!res.ok || !res.headers.get("Content-Type")?.includes("json")) return [];
	return (await res.json()) as CharacterSummary[];
}

export function App(): JSX.Element {
	const [mode, setMode] = createSignal<Mode>("character");
	const [displayId, setDisplayId] = createSignal(188); // blue murloc
	const [appearance, setAppearance] = createStore<CharacterAppearance>({
		race: 1,
		gender: 0,
		skin: 0,
		face: 0,
		hairStyle: 0,
		hairColor: 0,
		facialStyle: 0,
		items: [],
		showHelm: true,
		showCloak: true,
		showTabard: true,
		showEnchants: true,
	});
	const [modelPath, setModelPath] = createSignal(MODELS[0]);
	const [item, setItem] = createStore<ItemAppearance>({ itemEntry: 49623 }); // Shadowmourne
	const patchAppearance = (patch: Partial<CharacterAppearance>) => setAppearance((s) => mergeInto(s, patch));
	const patchItem = (patch: Partial<ItemAppearance>) => setItem((s) => mergeInto(s, patch));
	const [animation, setAnimation] = createSignal(0);
	const [animIds, setAnimIds] = createSignal<number[]>([]);
	const [status, setStatus] = createSignal("");
	const [error, setError] = createSignal("");
	const [search, setSearch] = createSignal("");
	const [selectedGuid, setSelectedGuid] = createSignal<number | null>(null);
	const [dbCharacter, setDbCharacter] = createSignal<CharacterDetails | null>(null);
	const [showTransmog, setShowTransmog] = createSignal(true);
	const [showPet, setShowPet] = createSignal(true);
	const [showBackground, setShowBackground] = createSignal(true);

	// Undefined until the first answer lands, so the first render does not wait on the DBCs.
	const races = createMemo<Map<number, ChrRace> | undefined>(() => gameData.races(), { loadingValue: undefined });
	const animNames = createMemo<Map<number, string> | undefined>(() => gameData.animationNames(), {
		loadingValue: undefined,
	});
	const options = createMemo<CustomizationOptions | undefined>(
		() => gameData.customizationOptions(appearance.race, appearance.gender),
		{ loadingValue: undefined },
	);
	// Deferred so a new search keeps the previous results on screen instead of holding the update.
	const results = createDeferred<CharacterSummary[]>(() => {
		const name = search();
		return name.length < 2 ? [] : searchCharacters(name);
	});

	// A model may not have the animation the previous one was playing.
	createEffect(animIds, (ids) => {
		if (ids.length > 0 && !ids.includes(untrack(animation))) setAnimation(ids[0]);
	});

	const loadCharacter = async (guid: number) => {
		setSelectedGuid(guid);
		setStatus("Loading character…");
		const res = await fetch(`/api/characters/${guid}`);
		if (!res.ok) {
			setStatus("");
			setError(`Failed to load character ${guid}: ${res.status}`);
			return;
		}
		const c = (await res.json()) as CharacterDetails;
		// The fetch is done; the Character puts the status back up if this appearance needs a build.
		setStatus("");
		setDbCharacter(c);
		applyCharacter(c, showTransmog());
		setMode("character");
	};

	/** The transmog only lends an item its look, so the enchant stays the real item's either way. */
	const characterItems = (c: CharacterDetails, transmog: boolean): CharacterItem[] =>
		c.equipment
			.filter((e) => !(transmog && e.transmogHidden))
			.map((e) => ({
				slot: e.slot,
				itemEntry: e.itemEntry,
				transmogEntry: transmog ? e.transmogEntry : undefined,
				enchant: e.enchant,
			}));

	const applyCharacter = (c: CharacterDetails, transmog: boolean) =>
		patchAppearance({
			race: c.race,
			gender: c.gender,
			classId: c.class,
			skin: c.skin,
			face: c.face,
			hairStyle: c.hairStyle,
			hairColor: c.hairColor,
			facialStyle: c.facialStyle,
			guildEmblem: c.guild,
			// The character's own choice to hide either piece, as the game stores it.
			showHelm: !c.hideHelm,
			showCloak: !c.hideCloak,
			// A hunter stands there holding its bow, every other class its melee weapons.
			drawRanged: drawsRangedWeapon(c.class),
			items: characterItems(c, transmog),
		});

	const toggleTransmog = (on: boolean) => {
		setShowTransmog(on);
		const c = dbCharacter();
		// Only the equipment changes, so the toggles the user has set since loading stay put.
		if (c) patchAppearance({ items: characterItems(c, on) });
	};

	const itemEntry = (slot: EquipmentSlot) => appearance.items?.find((i) => i.slot === slot)?.itemEntry ?? "";
	const setItemEntry = (slot: EquipmentSlot, value: string) => {
		const entry = Number(value);
		const items: CharacterItem[] = (appearance.items ?? []).filter((i) => i.slot !== slot);
		if (entry > 0) items.push({ slot, itemEntry: entry });
		patchAppearance({ items });
	};

	const onLoad = (inst: M2Instance) => {
		setError("");
		setStatus("");
		setAnimIds(inst.model.animationIds());
	};
	const onError = (e: unknown) => {
		setStatus("");
		setError(e instanceof Error ? e.message : String(e));
		console.error(e);
	};

	const numberSelect = (label: string, values: number[] | undefined, value: number, set: (v: number) => void) => (
		<div class="row">
			<label>{label}</label>
			<select value={value} onChange={(e) => set(Number(e.currentTarget.value))}>
				<For each={values ?? [value]}>
					{(v) => (
						<option value={v} selected={v === value}>
							{v}
						</option>
					)}
				</For>
			</select>
		</div>
	);

	return (
		<div class="app">
			<aside class="sidebar">
				<h1>WotLK 3D Viewer</h1>
				<div class="row">
					<label>Mode</label>
					<select value={mode()} onChange={(e) => setMode(e.currentTarget.value as Mode)}>
						<option value="character">Character</option>
						<option value="creature">Creature (display id)</option>
						<option value="item">Item (entry)</option>
						<option value="model">Model file</option>
					</select>
				</div>

				<Show when={mode() === "creature"}>
					<div class="row">
						<label>Display id</label>
						<input
							type="number"
							value={displayId()}
							onChange={(e) => setDisplayId(Number(e.currentTarget.value))}
						/>
					</div>
				</Show>

				<Show when={mode() === "item"}>
					<div class="row">
						<label>Item entry</label>
						<input
							type="number"
							value={item.itemEntry ?? ""}
							onChange={(e) =>
								patchItem({
									itemEntry: Number(e.currentTarget.value) || undefined,
									displayId: undefined,
								})
							}
						/>
					</div>
					<div class="row">
						<label>Display id</label>
						<input
							type="number"
							value={item.displayId ?? ""}
							onChange={(e) =>
								patchItem({
									displayId: Number(e.currentTarget.value) || undefined,
									itemEntry: undefined,
								})
							}
						/>
					</div>
					<div class="row">
						<label>Enchant</label>
						<input
							type="number"
							value={item.enchant ?? ""}
							onChange={(e) => patchItem({ enchant: Number(e.currentTarget.value) || undefined })}
						/>
					</div>
					<div class="row toggles">
						<label>
							<input
								type="checkbox"
								checked={item.showEnchants !== false}
								onChange={(e) => patchItem({ showEnchants: e.currentTarget.checked })}
							/>{" "}
							Enchants
						</label>
						{/* A shoulder appearance holds a left and a right piece; everything else only a left. */}
						<label>
							<input
								type="checkbox"
								checked={!!item.right}
								onChange={(e) => patchItem({ right: e.currentTarget.checked })}
							/>{" "}
							Right piece
						</label>
					</div>
					{/* Helms are cut per race and gender, so the variant has to be picked. */}
					<div class="row">
						<label>Helm fit</label>
						<select
							value={`${item.race ?? 1}|${item.gender ?? 0}`}
							onChange={(e) => {
								const [race, gender] = e.currentTarget.value.split("|").map(Number);
								patchItem({ race, gender });
							}}
						>
							<For each={PLAYABLE_RACES}>
								{(r) => (
									<>
										<option value={`${r}|0`}>{races()?.get(r)?.name ?? r} male</option>
										<option value={`${r}|1`}>{races()?.get(r)?.name ?? r} female</option>
									</>
								)}
							</For>
						</select>
					</div>
				</Show>

				<Show when={mode() === "model"}>
					<div class="row">
						<label>Model</label>
						<select value={modelPath()} onChange={(e) => setModelPath(e.currentTarget.value)}>
							<For each={MODELS}>{(m) => <option value={m}>{m.split("\\").pop()}</option>}</For>
						</select>
					</div>
					<div class="row">
						<label>Path</label>
						<input value={modelPath()} onChange={(e) => setModelPath(e.currentTarget.value)} />
					</div>
				</Show>

				<Show when={mode() === "character"}>
					<h2>Database character</h2>
					<input
						placeholder="Search by name…"
						value={search()}
						onInput={(e) => setSearch(e.currentTarget.value)}
					/>
					<Show when={results().length > 0}>
						<div class="list">
							<For each={results()}>
								{(c) => (
									<div
										class={{ active: selectedGuid() === c.guid }}
										onClick={() => void loadCharacter(c.guid).catch(onError)}
									>
										<span>{c.name}</span>
										<span>
											{races()?.get(c.race)?.name} · L{c.level}
										</span>
									</div>
								)}
							</For>
						</div>
					</Show>

					<h2>Appearance</h2>
					<div class="row">
						<label>Race</label>
						<select
							value={appearance.race}
							onChange={(e) =>
								patchAppearance({
									race: Number(e.currentTarget.value),
									skin: 0,
									face: 0,
									hairStyle: 0,
									hairColor: 0,
									facialStyle: 0,
								})
							}
						>
							<For each={PLAYABLE_RACES}>
								{(r) => <option value={r}>{races()?.get(r)?.name ?? r}</option>}
							</For>
						</select>
					</div>
					<div class="row">
						<label>Gender</label>
						<select
							value={appearance.gender}
							onChange={(e) =>
								patchAppearance({
									gender: Number(e.currentTarget.value),
									skin: 0,
									face: 0,
									hairStyle: 0,
									hairColor: 0,
									facialStyle: 0,
								})
							}
						>
							<option value={0}>Male</option>
							<option value={1}>Female</option>
						</select>
					</div>
					{numberSelect("Skin", options()?.skins, appearance.skin ?? 0, (v) => patchAppearance({ skin: v }))}
					{numberSelect("Face", options()?.faces, appearance.face ?? 0, (v) => patchAppearance({ face: v }))}
					{numberSelect("Hair style", options()?.hairStyles, appearance.hairStyle ?? 0, (v) =>
						patchAppearance({ hairStyle: v }),
					)}
					{numberSelect("Hair color", options()?.hairColors, appearance.hairColor ?? 0, (v) =>
						patchAppearance({ hairColor: v }),
					)}
					{numberSelect("Facial", options()?.facialStyles, appearance.facialStyle ?? 0, (v) =>
						patchAppearance({ facialStyle: v }),
					)}
					<div class="row toggles">
						<label>
							<input
								type="checkbox"
								checked={appearance.showHelm}
								onChange={(e) => patchAppearance({ showHelm: e.currentTarget.checked })}
							/>{" "}
							Helm
						</label>
						<label>
							<input
								type="checkbox"
								checked={appearance.showCloak}
								onChange={(e) => patchAppearance({ showCloak: e.currentTarget.checked })}
							/>{" "}
							Cloak
						</label>
						<label>
							<input
								type="checkbox"
								checked={appearance.showTabard}
								onChange={(e) => patchAppearance({ showTabard: e.currentTarget.checked })}
							/>{" "}
							Tabard
						</label>
						<label>
							<input
								type="checkbox"
								checked={appearance.sheathed}
								onChange={(e) => patchAppearance({ sheathed: e.currentTarget.checked })}
							/>{" "}
							Sheathed
						</label>
						<label>
							<input
								type="checkbox"
								checked={appearance.drawRanged}
								onChange={(e) => patchAppearance({ drawRanged: e.currentTarget.checked })}
							/>{" "}
							Ranged
						</label>
						<label>
							<input
								type="checkbox"
								checked={showTransmog()}
								onChange={(e) => toggleTransmog(e.currentTarget.checked)}
							/>{" "}
							Transmog
						</label>
						<label>
							<input
								type="checkbox"
								checked={appearance.showEnchants}
								onChange={(e) => patchAppearance({ showEnchants: e.currentTarget.checked })}
							/>{" "}
							Enchants
						</label>
						<label>
							<input
								type="checkbox"
								checked={showPet()}
								onChange={(e) => setShowPet(e.currentTarget.checked)}
							/>{" "}
							Pet
						</label>
						<label>
							<input
								type="checkbox"
								checked={showBackground()}
								onChange={(e) => setShowBackground(e.currentTarget.checked)}
							/>{" "}
							Background
						</label>
					</div>

					<h2>Equipment (item entries)</h2>
					<div class="slots">
						<For each={VISUAL_SLOTS}>
							{([slot, name]) => (
								<label>
									<input
										type="number"
										value={itemEntry(slot)}
										onChange={(e) => setItemEntry(slot, e.currentTarget.value)}
									/>
									{name}
								</label>
							)}
						</For>
					</div>
				</Show>

				<h2>Animation</h2>
				<div class="row">
					<label>Animation</label>
					<select value={animation()} onChange={(e) => setAnimation(Number(e.currentTarget.value))}>
						<For each={animIds()}>
							{(id) => (
								<option value={id} selected={id === animation()}>
									{animNames()?.get(id) ?? id}
								</option>
							)}
						</For>
					</select>
				</div>
				<Show when={error()}>
					<div class="error">{error()}</div>
				</Show>
			</aside>
			<main class="viewport">
				{/* `window.viewer` is exposed for poking at the scene from the devtools console. */}
				<WowViewer ref={(v) => ((window as unknown as { viewer: unknown }).viewer = v)}>
					{/* The race's character-creation scene, shown through its own camera as the
					    character-selection screen does: left-drag then turns the character. */}
					<Show when={mode() === "character" && showBackground()}>
						<Backdrop
							assets={assets}
							gameData={gameData}
							race={appearance.race}
							classId={appearance.classId}
							onError={onError}
						/>
					</Show>
					<Show when={mode() === "character"}>
						<Character
							assets={assets}
							gameData={gameData}
							appearance={appearance}
							animation={animation()}
							pivot
							backdropAttachment={BACKDROP_CHARACTER_ATTACHMENT}
							onLoadStart={() => setStatus("Loading character…")}
							onLoad={onLoad}
							onError={onError}
						/>
					</Show>
					{/* The loaded character's pet; it idles on its own, and the animation list stays the character's. */}
					<Show when={mode() === "character" && showPet() && dbCharacter()?.pet}>
						{(pet) => (
							<Creature
								assets={assets}
								gameData={gameData}
								displayId={pet().displayId}
								pet={pet()}
								position={petPosition}
								backdropAttachment={BACKDROP_PET_ATTACHMENT}
								onError={onError}
							/>
						)}
					</Show>
					<Show when={mode() === "creature"}>
						<Creature
							assets={assets}
							gameData={gameData}
							displayId={displayId()}
							animation={animation()}
							onLoad={onLoad}
							onError={onError}
						/>
					</Show>
					<Show when={mode() === "item"}>
						<Item
							assets={assets}
							gameData={gameData}
							item={item}
							animation={animation()}
							onLoad={onLoad}
							onError={onError}
						/>
					</Show>
					<Show when={mode() === "model"}>
						<Model
							assets={assets}
							path={modelPath()}
							animation={animation()}
							onLoad={onLoad}
							onError={onError}
						/>
					</Show>
				</WowViewer>
				<Show when={status()}>
					<div class="status">{status()}</div>
				</Show>
			</main>
		</div>
	);
}
