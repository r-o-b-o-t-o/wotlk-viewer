# wotlk-viewer

[![CI](https://github.com/r-o-b-o-t-o/wotlk-viewer/actions/workflows/ci.yml/badge.svg)](https://github.com/r-o-b-o-t-o/wotlk-viewer/actions/workflows/ci.yml)

WebGL renderer for World of Warcraft: Wrath of the Lich King (3.3.5a) models, written in TypeScript on top of
[three.js](https://threejs.org). It reads M2 models, `.skin`/`.anim` files, BLP textures and DBC tables straight
from an extracted game client and assembles fully equipped player characters.

## Packages

| Package                                                                                      | Purpose                                                                                                                                                                                                                                           |
| -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`@roboto_/wotlk-viewer-core`](https://www.npmjs.com/package/@roboto_/wotlk-viewer-core)     | Parsers (M2, SKIN, ANIM, BLP, DBC), three.js renderer (`M2Model`, `M2Instance`, `M2Material`, `Viewer`), `CharacterBuilder`, `CreatureBuilder`, `ItemBuilder`, `BackdropBuilder`, typed DBC access (`GameData`). UI-framework agnostic.           |
| [`@roboto_/wotlk-viewer-server`](https://www.npmjs.com/package/@roboto_/wotlk-viewer-server) | Node middleware / standalone server that serves the extracted client with case-insensitive paths and exposes AzerothCore characters over a small JSON API. Also `FsDataSource` (at `@roboto_/wotlk-viewer-server/fs`) for Node scripts and tests. |
| [`@roboto_/wotlk-viewer-solid`](https://www.npmjs.com/package/@roboto_/wotlk-viewer-solid)   | SolidJS components: `<WowViewer>`, `<Model>`, `<Character>`, `<Creature>`, `<Item>`, `<Backdrop>`.                                                                                                                                                |
| [`@roboto_/wotlk-viewer-react`](https://www.npmjs.com/package/@roboto_/wotlk-viewer-react)   | ReactJS components: `<WowViewer>`, `<Model>`, `<Character>`, `<Creature>`, `<Item>`, `<Backdrop>`.                                                                                                                                                |
| `apps/demo`                                                                                  | SolidJS demo: browse database characters and their pets, stand them in their race's character-creation scene, tweak appearance and equipment, play animations.                                                                                    |

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
} from "@roboto_/wotlk-viewer-core";

const assets = new AssetManager(new HttpDataSource("/data")); // served by @roboto_/wotlk-viewer-server
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

`viewer.seek(frame)` rewinds every model (particles and ribbons included) and plays `frame` steps at 60 per second,
so a given frame always shows the same pose with its particles spawned; `viewer.timeScale = 0` then freezes it there.

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
import { Character, WowViewer } from '@roboto_/wotlk-viewer-solid';

<WowViewer>
  <Character assets={assets} appearance={appearance()} animation={AnimationId.Stand} onLoad={(inst) => ...} />
</WowViewer>
```

`<Model assets path="Creature\Murloc\Murloc.m2" />` shows a raw model, `<Creature assets displayId={188} />` a creature
by display id, and `<Item assets item={{ itemEntry: 49623 }} />` one item on its own — a weapon, shield, helm...
All of them take a `position`, either `[x, y, z]` in the viewer's Z-up space or a function of the loaded instance;
`petPosition` is one such function, standing a pet off its owner's left shoulder and a step back.
Passing the character's pet to `<Creature pet>` also sizes it the way the client does,
and `pivot` frames and orbits the camera on the character rather than on the pair:

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
It targets Solid 2.0 (`solid-js` and `@solidjs/web`, currently release candidates).

### React

Same API as the SolidJS bindings, from `@roboto_/wotlk-viewer-react` (`WowViewer`, `Model`, `Character`, `Creature`, `Item`, `Backdrop`, `useViewer`).

### Serving game data

```ts
import { createMiddleware, startServer } from "@roboto_/wotlk-viewer-server";

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

## Known limitations

What is deliberately left out or approximated is listed in [docs/known-limitations.md](docs/known-limitations.md).

## Show your support

⭐️ Give the project a star if you like it!

<a href="https://ko-fi.com/roboto" target="_blank"><img height="35" style="border:0px; height:46px;" src="https://cdn.ko-fi.com/cdn/kofi5.png?v=3" border="0" alt="Buy Me a Coffee at ko-fi.com" />

## Contact

<img src="https://img.shields.io/badge/Discord-5865F2?style=flat&logo=discord&logoColor=white"/> Feel free to get in touch with me on Discord: `roboto_`
