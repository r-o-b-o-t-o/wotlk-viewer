# wotlk-3d-viewer

WebGL renderer for World of Warcraft: Wrath of the Lich King (3.3.5a) models, written in TypeScript on top of
[three.js](https://threejs.org). It reads M2 models, `.skin`/`.anim` files, BLP textures and DBC tables straight
from an extracted game client and assembles fully equipped player characters.

## Packages

| Package                | Purpose                                                                                                                                                                                                                                   |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@wotlk-viewer/core`   | Parsers (M2, SKIN, ANIM, BLP, DBC), three.js renderer (`M2Model`, `M2Instance`, `M2Material`, `Viewer`), `CharacterBuilder`, `CreatureBuilder`, typed DBC access (`GameData`). UI-framework agnostic.                                     |
| `@wotlk-viewer/server` | Node middleware / standalone server that serves the extracted client with case-insensitive paths and exposes AzerothCore characters over a small JSON API. Also `FsDataSource` (at `@wotlk-viewer/server/fs`) for Node scripts and tests. |
| `@wotlk-viewer/solid`  | SolidJS components: `<WowViewer>`, `<Model>`, `<Character>`, `<Creature>`.                                                                                                                                                                |
| `@wotlk-viewer/react`  | The same components for React.                                                                                                                                                                                                            |
| `apps/demo`            | SolidJS demo: browse database characters, tweak appearance and equipment, play animations.                                                                                                                                                |

## Getting started

Requirements: Node 22+, an extracted 3.3.5a client (a folder containing `Data` and `Data_<locale>` subfolders with the
MPQ contents), optionally an AzerothCore `characters` database.

Copy `.env.example` to `.env` and point `WOW_CLIENT_DIR` at your extracted client (`WOW_DB_URL` is optional;
without it the demo runs without the character API). Every package reads that one file.

```bash
cp .env.example .env
npm install
npm run dev
```

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

`Viewer` is a convenience (renderer, orbit camera, resize handling, render loop). `M2Instance` is a regular
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
by display id. `useViewer()` gives children the `Viewer`. For other frameworks, `mountInstance(viewer, load, opts)`
from the core package holds the same lifecycle (load, cancel, add, frame, dispose) behind one disposer.
The package ships TSX source (like most Solid libraries); compile it with `vite-plugin-solid` in the consuming app.

### React

Same API from `@wotlk-viewer/react` (`WowViewer`, `Model`, `Character`, `Creature`, `useViewer`). Needs a bundler with the
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

- `GET /data/<client path>` — raw file, case-insensitive, locale folders searched before `Data`. `?exists` answers
  200/204 without a body (used for cheap existence probes).
- `GET /api/characters?name=<prefix>&limit=20` — `{ guid, name, race, class, gender, level }[]`
- `GET /api/characters/<guid>` — the above plus `skin, face, hairStyle, hairColor, facialStyle` and
  `equipment: { slot, itemEntry, enchant, transmogEntry?, transmogHidden? }[]` (from `character_inventory` +
  `item_instance`). Both transmog fields come from mod-transmog's `custom_transmogrification` table, whose
  entry 1 means "hidden" rather than an appearance; the module is optional, so the server probes for that
  table once and omits the fields when it is absent. Drop the items flagged `transmogHidden` before building.
  `guild: { id, name, emblemStyle, emblemColor, borderStyle, borderColor, backgroundColor }` follows
  `guild_member` and is absent for a character without a guild; pass its emblem fields as `guildEmblem`.

Any other backend works as long as it implements `DataSource` (`readFile`, optional `exists`).

## How a character is built

1. `ChrRaces` → `CreatureDisplayInfo` → `CreatureModelData` gives the body model.
2. Geosets: hair from `CharHairGeosets`, facial features from `CharacterFacialHairStyles`, clothing groups from each
   item's `ItemDisplayInfo.GeosetGroup`, helmets hide groups through `HelmetGeosetVisData`.
3. Body texture: skin, face, facial hair, scalp and underwear layers from `CharSections`, then the region textures of
   every equipped item (`Item\TextureComponents\...`, gender-specific with `_U` fallback) composited on a 2D canvas. The
   guild tabard (the one item flagged in `ItemDisplayInfo`) instead takes background, border and emblem layers from
   `Textures\GuildEmblems` when `guildEmblem` is given.
4. Hair texture (texture type 6), cape (type 2) and monster textures are bound to the M2's replaceable slots.
5. Helm (`_<RacePrefix><M|F>` variant), shoulders, weapons and shields are loaded as separate `M2Instance`s and
   attached to the body's attachment points; they animate on their own.
6. A hand that carries something has its finger bones posed from the `HandsClosed` animation while the body keeps
   playing its own, so the grip closes around the weapon.

Rendering uses one draw group per skin batch with a small custom shader (1–2 texture layers, WoW blend modes,
vertex color / alpha / UV-transform tracks, ambient + directional light in gamma space like the original client).
Skinning goes through three.js' `SkinnedMesh` with bone matrices computed by `M2Animator` (translation, compressed
quaternion and scale tracks, global sequences, external `.anim` files loaded on demand).

## Known limitations and edge cases

Things deliberately left out or approximated; worth deciding on if they matter for your use case:

- Particle emitters use a simplified CPU simulation: head and tail quads with spin, but no tumble, wind or spline
  emitters. Ribbon emitters are not rendered. The head/tail choice comes from the `HeadStyle` and `TailStyle` flags,
  not the `HeadOrTail` byte, which is 0 on every 3.3.5a emitter.
- `ParticleColor.dbc` recolouring follows the `ParticleColorID` on `ItemDisplayInfo` and `CreatureDisplayInfo`. An
  emitter also has to ask for a colour set with a `particleColorIndex` of 11, 12 or 13, which narrows it to 38 items
  (all shoulders) and 381 creature displays.
- Enchant visuals (`ItemVisuals.dbc`) are not shown.
- A ranged weapon is only drawn on request (`drawRanged: true`), held in the left hand and the only thing held;
  the game never shows one while it is put away. `sheathed: true` moves main/off-hand weapons to the sheath
  attachments derived from `Item.dbc` `SheatheType`, and held off-hand items disappear, like in the game.
  Combining both gives the ranged stance: bow in hand, melee gear stowed.
- Translucent batches of one model are drawn in file order, with additive glow decals forced last, instead of being
  depth-sorted per submesh: every batch of a mesh shares one sort key in three.js. Models whose translucent layers
  need another order can still stack wrongly.
- Two-texture batches always use a multiply combiner. The second layer really has its own material, and every
  two-texture batch in the client's item models sits in a model with `globalFlags & 0x8`, which means that material
  comes from the "second texture material override" block indexed by the batch's shader id rather than from
  `materialIndex + 1`. That block is not parsed, so detail and env-map layers can look off. Batches never carry
  more than two textures.
- Particle `zSource`, which aims the emission away from a point on the emitter's Z axis, is deliberately skipped.
  It reaches about 14 base models, nearly all rifles and shotguns firing a muzzle flash, and was triaged as not
  worth the code.
- Bezier tracks are treated as hermite.
- Sequence switching is instant (no `blendTime` cross-fade) and Stand variations are not randomized (always variation 0
  unless you pass one).
- Only skin profile `00` (highest detail) is loaded.
- NPC humanoids (`CreatureDisplayInfoExtra`, baked NPC textures) are not supported; `CreatureBuilder` only handles
  monster texture variations and scale.
- `CharSections.Flags` are ignored, so `customizationOptions()` also lists NPC-only / death-knight-only skins.
- Geoset defaults: ears = 702, every other group = 1. Tail/loincloth groups (6, 14) were not verified beyond a visual
  check of Tauren and Draenei. Death knight eye glow is enabled from `classId === 6` (geoset 1703).
- Robes reset kneepads to 901 and take the trouser geoset from the chest; the boot geoset is left as-is.
- Item region textures are filtered per slot (e.g. gloves paint only hands and forearms) since `ItemDisplayInfo`
  rows carry the whole armor set; the robe rule adds the leg regions to chest pieces.
- The attachment `animateAttached` visibility track is ignored.
- Single directional light plus ambient; no fog or shadows. `Viewer` sets `outputColorSpace = LinearSRGBColorSpace`
  because shading is done in gamma space; mixing in standard three.js materials needs color-management care.
- DBC tables are assumed to use 4-byte fields (true for every 3.3.5a table read here). Little-endian host assumed.
- Items whose entry is missing from the client's `Item.dbc` (custom server items) are skipped, and a
  `transmogEntry` the client does not know counts as no transmog, falling back to the real item.
- `HttpDataSource.exists` sends a HEAD with `?exists`, which @wotlk-viewer/server answers 200/204 to keep missing
  files out of the browser console; any other backend just needs to answer 200 for a file that exists.
- Decoded textures are held twice while a model is on screen: three.js keeps the pixels on `DataTexture.image.data`
  after upload, and `AssetManager` caches the same `BlpImage` for the character skin compositor. The compressed
  source buffer is released once a BLP is decoded.
