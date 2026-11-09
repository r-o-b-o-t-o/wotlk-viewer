# wotlk-3d-viewer

WebGL renderer for World of Warcraft: Wrath of the Lich King (3.3.5a) models, written in TypeScript on top of
[three.js](https://threejs.org). It reads M2 models, `.skin`/`.anim` files, BLP textures and DBC tables straight
from an extracted game client and assembles fully equipped player characters.

## Packages

| Package                | Purpose                                                                                                                                                                                                                                   |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@wotlk-viewer/core`   | Parsers (M2, SKIN, ANIM, BLP, DBC), three.js renderer (`M2Model`, `M2Instance`, `M2Material`, `Viewer`), `CharacterBuilder`, `CreatureBuilder`, `ItemBuilder`, `BackdropBuilder`, typed DBC access (`GameData`). UI-framework agnostic.   |
| `@wotlk-viewer/server` | Node middleware / standalone server that serves the extracted client with case-insensitive paths and exposes AzerothCore characters over a small JSON API. Also `FsDataSource` (at `@wotlk-viewer/server/fs`) for Node scripts and tests. |
| `@wotlk-viewer/solid`  | SolidJS components: `<WowViewer>`, `<Model>`, `<Character>`, `<Creature>`, `<Item>`, `<Backdrop>`.                                                                                                                                        |
| `@wotlk-viewer/react`  | The same components for React.                                                                                                                                                                                                            |
| `apps/demo`            | SolidJS demo: browse database characters and their pets, stand them in their race's character-creation scene, tweak appearance and equipment, play animations.                                                                            |

## Getting started

Requirements: Node 22+, a 3.3.5a client, optionally an AzerothCore `characters` database.

Copy `.env.example` to `.env` and point `WOW_CLIENT_DIR` at where your extracted client should live (`WOW_DB_URL` is
optional; without it the demo runs without the character API). Every package reads that one file.

```bash
cp .env.example .env
npm install
npm run extract -w packages/server -- --client /path/to/wow --clean
npm run dev
```

### Extracting the client

`npm run extract -w packages/server` unpacks the MPQ archives into `WOW_CLIENT_DIR`, laid out as the client
addresses them from inside `Data`: the base archives' contents at the root, the locale ones under `<locale>/`. The
output directory has to be somewhere other than the client install itself.

It walks the archives in the client's own search order, so a file replaced by a late patch wins over the original.
That ordering is the point: tools that unpack archive by archive in directory order leave pre-patch copies in place,
and the result looks like a rendering bug rather than stale data — Hailstorm's blade, for one, loses the particle
emitter `patch.MPQ` adds to it.

```
--client <dir>   Client install holding Data/ (default: the parent of WOW_CLIENT_DIR)
--out <dir>      Where to write the extracted tree (default: WOW_CLIENT_DIR)
--locale <code>  Four-letter locale (default: detected from Data/)
--clean          Delete the output directory first
--jobs <n>       Files read at once from one archive (default 8)
-h, --help       Print this list
```

Already have an extract from another tool? It works as long as the layout matches and the precedence is right; the
`<locale>/` folder is what holds `DBFilesClient`.

Other scripts: `npm test` (Vitest, parser and DBC tests run against the real client and are skipped when it is absent),
`npm run typecheck`, `npm run build`, `npm run format` (Prettier, config in `.prettierrc`). Commit messages follow
[Conventional Commits](https://www.conventionalcommits.org/).

## Using the core library

```ts
import {
	AnimationId,
	AssetManager,
	CharacterBuilder,
	EquipmentSlot,
	GameData,
	Gender,
	HttpDataSource,
	Viewer,
} from "@wotlk-viewer/core";

const assets = new AssetManager(new HttpDataSource("/data")); // served by @wotlk-viewer/server
const viewer = new Viewer({ container: document.getElementById("view")! });
viewer.start();

const builder = new CharacterBuilder(assets, new GameData(assets), viewer.lighting);
const character = await builder.build({
	race: 1,
	gender: Gender.Male,
	skin: 2,
	face: 3,
	hairStyle: 5,
	hairColor: 1,
	facialStyle: 2,
	items: [
		{ slot: EquipmentSlot.Chest, itemEntry: 40423 }, // resolved through Item.dbc
		{ slot: EquipmentSlot.MainHand, displayId: 56663 }, // or a display id directly
	],
});
viewer.add(character);
viewer.frame();
await character.playAnimation(AnimationId.EmoteDance);
```

Plain models work the same way with `M2Instance.create(await assets.loadModel(path), assets, viewer.lighting)`;
creatures with `new CreatureBuilder(assets, gameData, viewer.lighting).build(displayId)`.

`BackdropBuilder` loads the scene a character-creation screen stands a character in — the nine models under
`Interface\Glues\Models`, with gnomes sharing the dwarf one, trolls the orc one, and death knights taking Acherus
whatever their race. `viewer.setBackdrop()` draws it in a pass of its own, seen through the camera baked into the
model, so the mouse controls never move it:

```ts
const backdrop = await new BackdropBuilder(assets, gameData, viewer.backdropLighting).build(race, classId);
if (backdrop) viewer.setBackdrop(backdrop.instance, backdrop.lighting);
```

`viewer.staticCamera = true` then shows the models through that same camera, which is how the character-selection
screen looks: the camera never moves, a left-drag turns the character (`viewer.facing`, 0.6° per pixel as the glue
screens rotate it) instead of orbiting, and the wheel does nothing. The models stand on the scene's own attachment
points rather than at their `position`, `BACKDROP_CHARACTER_ATTACHMENT` for the character and
`BACKDROP_PET_ATTACHMENT` for its pet, the way the client attaches them:

```ts
viewer.staticCamera = true;
viewer.setBackdropAttachment(character, BACKDROP_CHARACTER_ATTACHMENT);
viewer.setBackdropAttachment(pet, BACKDROP_PET_ATTACHMENT);
```

`Viewer` is a convenience (renderer, orbit camera, backdrop pass, resize handling, render loop). `viewer.pivot` names the instance
`frame()` fits and the camera orbits, its own body alone: the same character is framed the same way whatever it has
equipped and whatever stands next to it, and a pet or a polearm may start partly out of frame rather than push the
camera off its subject. `M2Instance` is a regular
`THREE.Object3D` in WoW's Z-up space, so it can be dropped into any three.js scene: call `instance.update(dtMs, camera)`
once per frame and parent it under a group rotated by `-90°` around X (see `Viewer.root`).

### SolidJS

```tsx
import { Character, WowViewer } from '@wotlk-viewer/solid';

<WowViewer>
  <Character assets={assets} appearance={appearance()} animation={AnimationId.Stand} onLoad={(inst) => ...} />
</WowViewer>
```

`<Model assets path="Creature\Murloc\Murloc.m2" />` shows a raw model, `<Creature assets displayId={188} />` a creature
by display id, and `<Item assets item={{ itemEntry: 49623 }} />` one item on its own — a weapon, shield, helm,
shoulder, quiver or ammo model, with its enchant's effect on it. All of them take a `position`, either `[x, y, z]` in
the viewer's Z-up space or a function of the loaded instance; `petPosition` is one such function, standing a pet off its owner's left shoulder and a step back. Passing
the character's pet to `<Creature pet>` also sizes it the way the client does, and `pivot` frames and orbits the
camera on the character rather than on the pair:

```tsx
<Character assets={assets} appearance={appearance()} pivot />
<Creature assets={assets} displayId={character.pet.displayId} pet={character.pet} position={petPosition} />
```

`<Backdrop assets race={1} classId={6} />` puts a character's character-creation scene behind everything, shown
through its own camera as the character-selection screen does — pass `staticCamera={false}` to keep orbiting
instead. Models take `backdropAttachment` to say where that scene stands them:

```tsx
<Backdrop assets={assets} race={appearance.race} classId={appearance.classId} />
<Character assets={assets} appearance={appearance} pivot backdropAttachment={BACKDROP_CHARACTER_ATTACHMENT} />
<Creature assets={assets} displayId={pet.displayId} pet={pet} backdropAttachment={BACKDROP_PET_ATTACHMENT} />
```

`useViewer()` gives children the `Viewer`. For other frameworks, `mountInstance(viewer, load, opts)`
from the core package holds the same lifecycle (load, cancel, add, frame, dispose) behind one disposer, and
`mountBackdrop(viewer, load)` does the same for a backdrop.
The package ships TSX source (like most Solid libraries); compile it with `vite-plugin-solid` in the consuming app.

### React

Same API as the SolidJS bindings, from `@wotlk-viewer/react` (`WowViewer`, `Model`, `Character`, `Creature`, `Item`, `Backdrop`, `useViewer`). Needs a bundler with the
automatic JSX runtime (Vite does this out of the box).

### Serving game data

```ts
import { createMiddleware, startServer } from "@wotlk-viewer/server";

// Standalone (CORS enabled), or plug the middleware into Vite/Express/Connect:
await startServer({
	clientDir: process.env.WOW_CLIENT_DIR!,
	db: { user: "root", password: "", database: "acore_characters" },
	port: 8090,
});
```

Endpoints:

- `GET /data/<client path>` — raw file, case-insensitive, locale folders searched before the root. `?exists` answers
  200/204 without a body (used for cheap existence probes).
- `GET /api/characters?name=<prefix>&limit=20` — `{ guid, name, race, class, gender, level }[]`
- `GET /api/characters/<guid>` — the above plus `skin, face, hairStyle, hairColor, facialStyle` and
  `equipment: { slot, itemEntry, enchant, transmogEntry?, transmogHidden? }[]` (from `character_inventory` +
  `item_instance`). Both transmog fields come from mod-transmog's `custom_transmogrification` table, whose
  entry 1 means "hidden" rather than an appearance; the module is optional, so the server probes for that
  table once and omits the fields when it is absent. Drop the items flagged `transmogHidden` before building.
  `hideHelm` / `hideCloak` are the two `characters.playerFlags` bits by which a player turns either piece of gear
  off; they map onto `showHelm` / `showCloak`, and the rest of the flags stay on the server.
  `guild: { id, name, emblemStyle, emblemColor, borderStyle, borderColor, backgroundColor }` follows
  `guild_member` and is absent for a character without a guild; pass its emblem fields as `guildEmblem`.
  `pet: { entry, displayId, name, level, family, tamed }` is the `character_pet` row in slot 0, the one the
  character currently has out; the stabled ones are not returned, and death knights are left out since every
  one of them carries the same ghoul. `displayId` goes straight to `CreatureBuilder` / `<Creature>`, and the
  whole object goes to their `pet` argument, which sizes a tamed pet from `CreatureFamily.dbc`. `family` is
  `creature_template.family`, read from the world database — `worldDatabase`, by default the characters
  database with a `_characters` suffix swapped for `_world`. That one is optional too: without it `family`
  is 0 and pets keep their display scale, which leaves tamed ones at full NPC size.

Any other backend works as long as it implements `DataSource` (`readFile`, optional `exists`).

## How a character is built

1. `ChrRaces` → `CreatureDisplayInfo` → `CreatureModelData` gives the body model.
2. Geosets: hair from `CharHairGeosets`, facial features from `CharacterFacialHairStyles`, clothing groups from each
   item's `ItemDisplayInfo.GeosetGroup`, helmets hide groups through `HelmetGeosetVisData`.
3. Body texture: skin, face, facial hair, scalp and underwear layers from `CharSections`, then the region textures of
   every equipped item (`Item\TextureComponents\...`, gender-specific with `_U` fallback) composited on a 2D canvas. The
   guild tabard (the one item flagged in `ItemDisplayInfo`) instead takes background, border and emblem layers from
   `Textures\GuildEmblems` when `guildEmblem` is given.
4. Hair texture (texture type 6), cape (type 2) and monster textures are bound to the M2's replaceable slots. A bald
   hair style carries no texture of its own, so the colour's sheet is taken from another style: facial hair samples
   the same slot, and orc and gnome male beards come out untextured otherwise.
5. Helm (`_<RacePrefix><M|F>` variant), shoulders, weapons and shields are loaded as separate `M2Instance`s and
   attached to the body's attachment points; they animate on their own.
6. A hand that carries something has its finger bones posed from the `HandsClosed` animation while the body keeps
   playing its own, so the grip closes around the weapon.

Rendering uses one draw group per skin batch with a small custom shader (1–2 texture layers, WoW blend modes,
vertex color / alpha / UV-transform tracks, ambient + up to three directional and four point lights and linear fog,
in gamma space like the original client).
Skinning goes through three.js' `SkinnedMesh` with bone matrices computed by `M2Animator` (translation, compressed
quaternion and scale tracks, global sequences, external `.anim` files loaded on demand).

## Known limitations

What is deliberately left out or approximated is listed in [docs/known-limitations.md](docs/known-limitations.md).
