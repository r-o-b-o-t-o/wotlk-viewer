# wotlk-3d-viewer

WebGL renderer for World of Warcraft: Wrath of the Lich King (3.3.5a) models, written in TypeScript on top of
[three.js](https://threejs.org). It reads M2 models, `.skin`/`.anim` files, BLP textures and DBC tables straight
from an extracted game client and assembles fully equipped player characters.

## Packages

| Package                | Purpose                                                                                                                                                                                                                                   |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@wotlk-viewer/core`   | Parsers (M2, SKIN, ANIM, BLP, DBC), three.js renderer (`M2Model`, `M2Instance`, `M2Material`, `Viewer`), `CharacterBuilder`, `CreatureBuilder`, `BackdropBuilder`, typed DBC access (`GameData`). UI-framework agnostic.                  |
| `@wotlk-viewer/server` | Node middleware / standalone server that serves the extracted client with case-insensitive paths and exposes AzerothCore characters over a small JSON API. Also `FsDataSource` (at `@wotlk-viewer/server/fs`) for Node scripts and tests. |
| `@wotlk-viewer/solid`  | SolidJS components: `<WowViewer>`, `<Model>`, `<Character>`, `<Creature>`, `<Backdrop>`.                                                                                                                                                  |
| `@wotlk-viewer/react`  | The same components for React.                                                                                                                                                                                                            |
| `apps/demo`            | SolidJS demo: browse database characters and their pets, stand them in their race's character-creation scene, tweak appearance and equipment, play animations.                                                                            |

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

`BackdropBuilder` loads the scene a character-creation screen stands a character in — the nine models under
`Interface\Glues\Models`, with gnomes sharing the dwarf one, trolls the orc one, and death knights taking Acherus
whatever their race. `viewer.setBackdrop()` draws it in a pass of its own, seen through the camera baked into the
model, so the mouse controls never move it:

```ts
const backdrop = await new BackdropBuilder(assets, gameData, viewer.backdropLighting).build(race, classId);
if (backdrop) viewer.setBackdrop(backdrop.instance, backdrop.lighting);
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
by display id. All three take a `position`, either `[x, y, z]` in the viewer's Z-up space or a function of the loaded
instance; `petPosition` is one such function, standing a pet off its owner's left shoulder and a step back. Passing
the character's pet to `<Creature pet>` also sizes it the way the client does, and `pivot` frames and orbits the
camera on the character rather than on the pair:

```tsx
<Character assets={assets} appearance={appearance()} pivot />
<Creature assets={assets} displayId={character.pet.displayId} pet={character.pet} position={petPosition} />
```

`<Backdrop assets race={1} classId={6} />` puts a character's character-creation scene behind everything.

`useViewer()` gives children the `Viewer`. For other frameworks, `mountInstance(viewer, load, opts)`
from the core package holds the same lifecycle (load, cancel, add, frame, dispose) behind one disposer, and
`mountBackdrop(viewer, load)` does the same for a backdrop.
The package ships TSX source (like most Solid libraries); compile it with `vite-plugin-solid` in the consuming app.

### React

Same API from `@wotlk-viewer/react` (`WowViewer`, `Model`, `Character`, `Creature`, `Backdrop`, `useViewer`). Needs a bundler with the
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

## Known limitations and edge cases

Things deliberately left out or approximated; worth deciding on if they matter for your use case:

- Particle emitters use a simplified CPU simulation: head and tail quads with spin, but no tumble, wind or spline
  emitters. Ribbon emitters are not rendered. The head/tail choice comes from the `HeadStyle` and `TailStyle` flags,
  not the `HeadOrTail` byte, which is 0 on every 3.3.5a emitter.
- An emitter without `LocalFrame` sheds its particles into the scene at birth, where the client sheds them into the
  model's frame of reference — the unit's own matrix when it has one, the world otherwise. The two coincide for a
  character standing still, which is all the demo shows, but a moving model would drag such particles along in the
  client and leave them behind here. The particle mesh of such an emitter also sorts against other translucent
  objects from the scene origin rather than from the model, since its own transform becomes the identity; that only
  matters for the few emitters using the Alpha blend mode, additive ones being order-independent.
- An emitter's pool is sized like the client's, `(life + lifeVariation) * (rate + rateVariation) * 1.15`, grown as
  those numbers rise and never shrunk, with emission stopping while it is full. Rounding that down to whole
  particles, as the client does, silences an emitter whose rate and life multiply to less than 1/1.15: it reaches 17
  emitters, 4 of them on items, each wanting roughly one particle every few seconds — three of the seven on
  `Shoulder_Plate_RaidPaladin_C_01`, which keeps the rest. On top sits a ceiling of `maxParticles`, 512 by default,
  which the client has no equivalent of; 171 emitters ask for more than that and would be thinned here, none of
  them on an item or character model.
- A particle emitter takes the scene lighting unless its `Unlit` flag is set — 2,393 of the 6,985 emitters on item
  models — shaded per vertex from the single normal the client hands a whole emitter: straight up in the world.
  Because this viewer's lights point in view space rather than the world's, that shade swings as the camera orbits,
  brightest looking down on a model and dimmest looking up, where the client's world-space sun holds it steady.
- `ParticleColor.dbc` recolouring follows the `ParticleColorID` on `ItemDisplayInfo` and `CreatureDisplayInfo`. An
  emitter also has to ask for a colour set with a `particleColorIndex` of 11, 12 or 13, which narrows it to 38 items
  (all shoulders) and 381 creature displays.
- Enchant visuals (`ItemVisuals.dbc`) are not shown.
- A ranged weapon is only drawn on request (`drawRanged: true`), held in the left hand and the only thing held;
  the game never shows one while it is put away. `sheathed: true` moves main/off-hand weapons to the sheath
  attachments derived from `Item.dbc` `SheatheType`, and held off-hand items disappear, like in the game.
  Combining both gives the ranged stance: bow in hand, melee gear stowed.
- Translucent batches of one model are drawn in `priorityPlane` order, additive glow decals last within a plane and
  file order under that, instead of being depth-sorted per submesh: every batch of a mesh shares one sort key in
  three.js. That covers the glue backdrops, which lean on the planes heavily, and about one model in twenty sets
  them at all; the rest fall back to the same file order as before. Models whose translucent layers need a
  viewpoint-dependent order can still stack wrongly. A particle emitter carries its own plane the same way, but
  since the body is one object the plane only orders an emitter against the other emitters and against the body
  as a whole, where the client sorts it against each geometry batch in turn.
- The second texture layer's combiner comes from `textureCombinerCombos`, indexed by the batch's shader id. The
  first layer's op is assumed to be a modulate, which holds on all but two of the client's item batches, and the
  Decal, Fade and Envmap ops are not modelled and fall back to a modulate. Batches never carry more than two
  textures.
- Particle `zSource`, which aims the emission away from a point on the emitter's Z axis, is deliberately skipped.
  It reaches 163 base models, 48 of them items — every one a rifle or shotgun firing a muzzle flash bar the
  Transcendence priest helm — and was triaged as not worth the code. The client reads it ahead of
  `HemisphereUpDirection`, so the 76 sphere emitters carrying both take the up direction here where the client
  aims them away from the source instead; none of those is on an item.
- A model-wide alpha is not modelled, so nothing here fades. The client scales both a geometry batch's alpha and
  every particle's alpha track by the model's own fade (`m_alpha` and `m_alphaScale`, each built from
  `m_fadeAlpha`), and stops drawing either once the product falls under 1e-4. That fade is gameplay state —
  stealth, a dying unit, a missile fading in with distance, a glue frame fading up — and never comes out of the M2
  file, so the factor would be a constant 1 here. Only a caller that wants to fade a model needs it.
- A rotation track holding a single key for a single sequence does not turn a model's **root** bone
  (index 0, which has no parent) unless it runs off a global sequence. A tally over `Item`, `Creature` and
  `Character` finds exactly four such keys, every one on a shoulder pad: `LShoulder`/`RShoulder_Cloth_PVPPriest_B_01`,
  `RShoulder_Cloth_PVPMage_B_01` and `RShoulder_Leather_Northrend_B_03`. Applying the 114 degrees they ask for
  turns the pad to face backwards, which is not how the game wears them. The same tally finds 148 lone keys on
  bones further down, and those are real posing the viewer keeps: the two that lay the glow of
  `Sword_2H_Frostmourne_D_01` along its blade rather than across it, the three gems a `Helm_Leather_Sunwell` turns
  outwards, and so on. The attachment drives an item's root bone, which is why a rotation baked onto that one bone
  reads as an authoring leftover while the others do not.
  The client's own guard on these tracks, `count > 1 || keys > m_uint90`, does not explain the difference: it is
  blind to which bone a track sits on, and `m_uint90` is 0 on a model's first frame, so by the decompilation the
  client samples the key once and reuses the cached value forever. The rule above comes from the files and from
  how the game looks, not from that guard, so a model posing differently here is worth a second look.
- Bezier tracks are treated as hermite.
- Sequence switching is instant (no `blendTime` cross-fade) and Stand variations are not randomized (always variation 0
  unless you pass one).
- Only skin profile `00` (highest detail) is loaded.
- NPC humanoids (`CreatureDisplayInfoExtra`, baked NPC textures) are not supported; `CreatureBuilder` only handles
  monster texture variations and scale.
- `CharSections.Flags` are ignored, so `customizationOptions()` also lists NPC-only / death-knight-only skins.
- A tamed pet's size is its `CreatureFamily.dbc` scale for its level, on top of the display scale, which is what
  AzerothCore sends as the pet's object scale; summons (warlock, mage) keep the display scale, and their families
  carry one flat value anyway. The family scale is then capped at 1.0, standing in for AzerothCore's own cap on
  eleven exotic families: of those only the crab's DBC value (1.4) is above 1.0, so the flat cap reproduces the
  whole correction, and the one family it trims that the server does not is the cat (1.1).
- `petPosition` assumes a fixed character half-width rather than measuring the owner, since every playable race is
  about as broad. The pet's own distance follows the narrower of its two horizontal bind-pose extents, because a
  bind pose splays wings or arms along one axis and would otherwise push a moth halfway across the scene. Both
  models face forward and stand on the same ground, where the game angles a pet slightly inwards. A wide pet can
  start partly out of frame, since `frame()` fits the character's body alone — as can a two-hander, which reaches
  about twice as far as the character carrying it; orbiting or zooming out brings either in.
- Geoset defaults: ears = 702, every other group = 1. Tail/loincloth groups (6, 14) were not verified beyond a visual
  check of Tauren and Draenei. Death knight eye glow is enabled from `classId === 6` (geoset 1703).
- Robes reset kneepads to 901 and take the trouser geoset from the chest; the boot geoset is left as-is.
- Item region textures are filtered per slot (e.g. gloves paint only hands and forearms) since `ItemDisplayInfo`
  rows carry the whole armor set; the robe rule adds the leg regions to chest pieces.
- The attachment `animateAttached` visibility track is ignored.
- Ambient plus up to three directional and four point lights and linear fog, no shadows. Four covers all but one of
  the 119 models in the client that carry lights at all (one has fifteen). Point lights fall off the way the glue
  screens light with — no constant term, 0.7 linear and 0.03 quadratic — so a light's own `attenuation_start` and
  `attenuation_end` go unread, and only its diffuse side is used, every light in the client with an ambient term
  being a backdrop's directional one. `Viewer` sets `outputColorSpace = LinearSRGBColorSpace` because shading is
  done in gamma space; mixing in standard three.js materials needs color-management care.
- A backdrop is a second render pass with the depth buffer cleared after it, so the character is drawn on top of the
  whole scene and framed by `frame()` — where the client puts it inside the scene, at the point its camera looks at,
  with foreground props able to cover it and a shadow on the ground. Nothing else about the two passes is shared:
  the models keep the viewer's own lighting and stay unfogged.
- A backdrop is lit from two places, as the glue screen lights it: its scene light set and fog are the `RaceLights`
  and `CharModelFogInfo` tables in the client's `Interface\GlueXML\GlueParent.lua`, and its moonwells, torches and
  braziers are the point lights inside the model itself, which follow their bones and flicker on their global
  sequences. The model's own directional entries are skipped, since they repeat what `RaceLights` already says —
  checked against all eight scenes, where the two agree to three decimals. The per-scene `SetGlow` bloom amount is
  not implemented, which leaves the brightest scenes a little flatter than the client's. Fog reaches only the
  opaque, alpha-key and alpha batches: it washes an additive or modulated one out instead of dimming it.
- A backdrop is shown through camera 0 of its own model, using only the camera's base position and target. The
  position and target tracks are ignored, which costs nothing here: all eight scenes leave them at zero. Below 4:3
  the vertical field of view stops widening, so a tall viewport crops the sides rather than looking past the top of
  a scene the client never framed that way.
- DBC tables are assumed to use 4-byte fields (true for every 3.3.5a table read here). Little-endian host assumed.
- Items whose entry is missing from the client's `Item.dbc` (custom server items) are skipped, and a
  `transmogEntry` the client does not know counts as no transmog, falling back to the real item.
- `HttpDataSource.exists` sends a HEAD with `?exists`, which @wotlk-viewer/server answers 200/204 to keep missing
  files out of the browser console; any other backend just needs to answer 200 for a file that exists.
- Decoded textures are held twice while a model is on screen: three.js keeps the pixels on `DataTexture.image.data`
  after upload, and `AssetManager` caches the same `BlpImage` for the character skin compositor. The compressed
  source buffer is released once a BLP is decoded.
