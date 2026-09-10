import { createEffect, createResource, createSignal, For, on, Show, type JSX } from "solid-js";
import { createStore } from "solid-js/store";
import {
	AssetManager,
	EquipmentSlot,
	GameData,
	HttpDataSource,
	petPosition,
	type CharacterAppearance,
	type CharacterItem,
	type M2Instance,
} from "@wotlk-viewer/core";
import { Backdrop, Character, Creature, Model, WowViewer } from "@wotlk-viewer/solid";
// Type-only, so the server package is erased from the browser bundle.
import type { CharacterDetails, CharacterSummary } from "@wotlk-viewer/server";

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

type Mode = "character" | "model" | "creature";

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
	});
	const [modelPath, setModelPath] = createSignal(MODELS[0]);
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

	const [races] = createResource(() => gameData.races());
	const [animNames] = createResource(() => gameData.animationNames());

	// A model may not have the animation the previous one was playing.
	createEffect(
		on(animIds, (ids) => {
			if (ids.length > 0 && !ids.includes(animation())) setAnimation(ids[0]);
		}),
	);
	const [options] = createResource(
		() => [appearance.race, appearance.gender] as const,
		([race, gender]) => gameData.customizationOptions(race, gender),
	);
	const [results] = createResource(search, async (name) => {
		if (name.length < 2) return [] as CharacterSummary[];
		return (await (
			await fetch(`/api/characters?name=${encodeURIComponent(name)}&limit=30`)
		).json()) as CharacterSummary[];
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
		setDbCharacter(c);
		applyCharacter(c, showTransmog());
		setMode("character");
	};

	/** One store write per change, so the character is rebuilt once. */
	const applyCharacter = (c: CharacterDetails, transmog: boolean) =>
		setAppearance({
			race: c.race,
			gender: c.gender,
			classId: c.class,
			skin: c.skin,
			face: c.face,
			hairStyle: c.hairStyle,
			hairColor: c.hairColor,
			facialStyle: c.facialStyle,
			guildEmblem: c.guild,
			items: c.equipment
				.filter((e) => !(transmog && e.transmogHidden))
				.map((e) => ({
					slot: e.slot,
					itemEntry: e.itemEntry,
					transmogEntry: transmog ? e.transmogEntry : undefined,
				})),
		});

	const toggleTransmog = (on: boolean) => {
		setShowTransmog(on);
		const c = dbCharacter();
		if (c) applyCharacter(c, on);
	};

	const itemEntry = (slot: EquipmentSlot) => appearance.items?.find((i) => i.slot === slot)?.itemEntry ?? "";
	const setItemEntry = (slot: EquipmentSlot, value: string) => {
		const entry = Number(value);
		const items: CharacterItem[] = (appearance.items ?? []).filter((i) => i.slot !== slot);
		if (entry > 0) items.push({ slot, itemEntry: entry });
		setAppearance("items", items);
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
					<Show when={(results() ?? []).length > 0}>
						<div class="list">
							<For each={results()}>
								{(c) => (
									<div
										classList={{ active: selectedGuid() === c.guid }}
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
								setAppearance({
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
								setAppearance({
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
					{numberSelect("Skin", options()?.skins, appearance.skin ?? 0, (v) => setAppearance("skin", v))}
					{numberSelect("Face", options()?.faces, appearance.face ?? 0, (v) => setAppearance("face", v))}
					{numberSelect("Hair style", options()?.hairStyles, appearance.hairStyle ?? 0, (v) =>
						setAppearance("hairStyle", v),
					)}
					{numberSelect("Hair color", options()?.hairColors, appearance.hairColor ?? 0, (v) =>
						setAppearance("hairColor", v),
					)}
					{numberSelect("Facial", options()?.facialStyles, appearance.facialStyle ?? 0, (v) =>
						setAppearance("facialStyle", v),
					)}
					<div class="row toggles">
						<label>
							<input
								type="checkbox"
								checked={appearance.showHelm}
								onChange={(e) => setAppearance("showHelm", e.currentTarget.checked)}
							/>{" "}
							Helm
						</label>
						<label>
							<input
								type="checkbox"
								checked={appearance.showCloak}
								onChange={(e) => setAppearance("showCloak", e.currentTarget.checked)}
							/>{" "}
							Cloak
						</label>
						<label>
							<input
								type="checkbox"
								checked={appearance.showTabard}
								onChange={(e) => setAppearance("showTabard", e.currentTarget.checked)}
							/>{" "}
							Tabard
						</label>
						<label>
							<input
								type="checkbox"
								checked={appearance.sheathed}
								onChange={(e) => setAppearance("sheathed", e.currentTarget.checked)}
							/>{" "}
							Sheathed
						</label>
						<label>
							<input
								type="checkbox"
								checked={appearance.drawRanged}
								onChange={(e) => setAppearance("drawRanged", e.currentTarget.checked)}
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
					{/* The race's character-creation scene; it keeps its own camera and never orbits. */}
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
