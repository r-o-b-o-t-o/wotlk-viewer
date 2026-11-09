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

Same API from `@wotlk-viewer/react` (`WowViewer`, `Model`, `Character`, `Creature`, `Item`, `Backdrop`, `useViewer`). Needs a bundler with the
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

## Known limitations and edge cases

Things deliberately left out or approximated; worth deciding on if they matter for your use case:

- The extractor decodes zlib and PKWARE-imploded sectors, which covers all but 8 files of a 3.3.5a client; those 8
  use bzip2 (six `.skin` files, two `.blp`). A run lists what it skipped and why.
- It also leaves out `base-<locale>.MPQ` and `backup-<locale>.MPQ`, which hold the installer's own files and are not
  in the client's search chain.

- Particle emitters use a simplified CPU simulation: head and tail quads with spin, but no tumble, wind or spline
  emitters. The head/tail choice comes from the `HeadStyle` and `TailStyle` flags,
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
- An enchant's effect follows `SpellItemEnchantment.ItemVisual` into `ItemVisuals.dbc`, whose five slots hang one
  `ItemVisualEffects.dbc` model each on the item model's ItemVisual attachments (ids 0-4). 225 of the 2,656
  enchants name a visual; 29 of their 618 slots in use hold junk in place of an effect id, all on enchants no
  spell grants, and are skipped. A held item also carries its own `ItemDisplayInfo.ItemVisual`, which is what makes
  an item glow unenchanted; an enchant's visual replaces it, the choice `CCharacterComponent::AddHandItem` makes.
  1,633 appearances name one, 1,383 of them a row that exists. Only held items take it: a helm or shoulder shows an
  enchant's visual and nothing else, as the client's own `AddHelm` and `AddShoulders` do. 877 item entries reach a
  visual this way, across 67 of them; every effect model they name is on disk but one, visual 144's
  `Spells\BloodBold_Missile_Low.mdx`, which is a typo for `BloodBolt` and so shows nothing in the client either.
- `ItemBuilder` / `<Item>` shows only the pieces that have a model of their own under
  `Item\ObjectComponents`: weapons, shields, helms, shoulders, quivers and ammo. Armour that the client draws
  as a body texture — chests, legs, gloves, belts, boots, bracers, tabards and cloaks — has no model to show and
  is reported as such. A shoulder appearance holds a left and a right piece, picked with `right`; anything else
  has only the one, and asking for its right piece gets that. Helms are cut per race and gender, so an item
  shown alone needs a `race`/`gender` to pick the variant, human male by default.
- Glowing eyes (geoset 1703) are turned on for the death knight class alone. The client also lights them for a
  face whose `CharSections` row carries flag 0x4, which in 3.3.5a marks the death knight face and skin colour
  combinations — face variations 12-23 plus the pale re-colours of a couple of ordinary faces, per race. Picking
  one of those on a character of another class, which the demo's free appearance pickers allow and the game does
  not, leaves the eyes dark here. A helm that hides the eye glow never reaches a death knight: the client forces
  the geoset back on at draw time, after the helmet masks.
- A robe in the chest slot or a dress in the legs slot (`ItemDisplayInfo.GeosetGroup[2]`, 530 and 118 appearances)
  drops the boot and pant geosets outright and keeps the plain legcuff, as `CCharacterComponent::GeosRenderPrep`
  does. Only a chest robe paints the leg regions; a chest that is not one keeps its `LegUpper`/`LegLower`
  textures unused, where the client always applies them — it reaches 28 appearances, every one a matching pant
  texture for a set the character would be wearing anyway. The chest flag 0x4 that suppresses the pants under any
  chest is not honoured either: it would also have to skip the pant textures on the legs and paint the underwear
  back in, and only 15 of the client's 57,986 appearances carry it.
- Races whose `ChrRaces` flags carry `BareFeet` — troll, tauren, draenei and forest troll — take no item texture
  on the foot region, so they stay barefoot whatever they are shod in. The boot geometry still shows; it is only
  the skin under it that the client refuses to paint.

- A ranged weapon is only drawn on request (`drawRanged: true`), held in the left hand and the only thing held;
  the game never shows one while it is put away. `sheathed: true` moves main/off-hand weapons to the sheath
  attachments derived from `Item.dbc` `SheatheType`, and held off-hand items disappear, like in the game.
  Combining both gives the ranged stance: bow in hand, melee gear stowed. Which of the two a character-selection
  screen shows is decided by class alone — `ShowCharacter` skips both hand slots for a hunter and the ranged slot
  for everyone else, so `drawsRangedWeapon(classId)` is what the demo sets `drawRanged` from when a character is
  loaded. Nothing is ever sheathed there: the client adds every weapon with `SHEATHE_NONE`.
- A bow's string is drawn as `CDrawBowString::DrawBowString` draws it: two unlit, untextured lines from the
  `$WTT` event at one limb tip, through the draw hand, to `$WTB` at the other, coloured with the scene's
  ambient. The hand is where an archer holds the nock, and the client only has one while a unit is in ranged
  mode (the arrow-hand attachment, or the right hand); given no unit it uses the midpoint of the two anchors,
  which leaves the string straight. That is the only form here, and the only one a character-selection screen
  shows: its `GlueDrawBowStringCB` passes no unit. Nothing is drawn back, since no ranged animation state
  exists here to draw it. The line is one pixel wide at any distance, as the client's own `GxPrim_Lines` is.
  Which items get one follows the glue screen's rule, `INVTYPE_RANGED`, which in 3.3.5a is the bows: 305
  entries, of which 303 are bows, one a crossbow (21550) and one an armour row typed by mistake (19837). 304
  of their models carry both anchors; 21550's does not, so that crossbow shows no string. Every other
  crossbow, like every gun and wand, is `INVTYPE_RANGEDRIGHT`, and a thrown weapon is `INVTYPE_THROWN`; none
  of them gets a string — the client's own in-world rule is narrower still, hooking the string on item class
  2 subclass 2, bows alone. Carrying the two anchors means little by itself, since weapon trails hang off the
  same pair: most swords and axes have them, and Shadowmourne would be strung if the inventory type did not
  decide it. An item shown on its own by display id has no inventory type to go on, so `<Item displayId>`
  leaves a bow stringless where `<Item itemEntry>` strings it; in a character's ranged slot a display id
  falls back to the slot's own type instead, which strings whatever model stands in it.
- Translucent batches of one model are drawn in `priorityPlane` order, additive glow decals last within a plane and
  file order under that, instead of being depth-sorted per submesh: every batch of a mesh shares one sort key in
  three.js. That covers the glue backdrops, which lean on the planes heavily, and about one model in twenty sets
  them at all; the rest fall back to the same file order as before. Models whose translucent layers need a
  viewpoint-dependent order can still stack wrongly. A particle emitter carries its own plane the same way, but
  since the body is one object the plane only orders an emitter against the other emitters and against the body
  as a whole, where the client sorts it against each geometry batch in turn.
- Across models the same sort key decides it, so a backdrop is drawn before everything standing in it rather than
  depth-sorted against it: a model's translucent parts always win. The client sorts the lot together, and letting
  three.js do the same is not on offer — a model and the items on it need their own order, which puts them in a
  band of their own and so ahead of or behind a backdrop wholesale. Standing the backdrop first is the way round
  that suits a character-selection screen, where the models stand in front of the scene; translucent scene
  geometry genuinely nearer than a model, such as a tuft of the Tauren scene's foreground grass, loses to it.
- A batch's combiner ops and its texture layers go through the client's own two rewrites,
  `CM2Shared::SubstituteSimpleShaders` and `SubstituteSpecializedShaders`, and the 23 pixel shaders they select
  between are implemented as written. The second rewrite folds a multi-layer material — a base pass, a
  sphere-mapped Mod2x or Add over it, and an alpha pass on top — into a single two-texture draw, which drops 7,246
  of the client's 61,170 batches and sends 5,286 through the three specialized shaders. Batches never carry more
  than two textures.
- A one-texture batch reading UV set 1 takes its texture matrix in slot 0, where the client moves it to slot 1
  (the `0x4000` bit of the rewritten shader id, which pairs with its `Diffuse_T2` vertex shader). It is the same
  matrix on the same coordinates either way, so the two should agree; the BLS shader that would settle it has not
  been decompiled. It reaches 87 batches on 82 models, 33 of which carry a texture transform at all.
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
- A pet's size is its `CreatureFamily.dbc` scale for its level and nothing else, as `ShowCharacter` sizes it: the
  family's scale at `minScaleLevel` growing to the one at `maxScaleLevel`, which _replaces_ what
  `CreatureModelData` and `CreatureDisplayInfo` asked for rather than scaling it. Warlock and death knight pets
  have a family too (felguard 0.9, imp 0.5, voidwalker 0.8, ghoul 1.0), carrying one flat value at both ends, so
  they are sized the same way; a grown cat reaches 1.1 and a crab 1.4, both over the 1.0 cap AzerothCore applies
  to the object scale it sends for the world, which the glue screen never asks for. "Remote Control", the one
  family with no size of its own, leaves the display's scale alone. Everything that is not a pet is drawn at
  `CreatureModelData.ModelScale` times `CreatureDisplayInfo.CreatureModelScale`, the first of which is 1 on all
  but three of the client's 1,331 model rows.
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
- Lighting is worked out per vertex and clamped to 1 there, as the client's is: it lights a vertex and hands the
  result down as a vertex colour, which the hardware clamps before interpolating. Both halves show next to a close
  light — the undead scene hangs a dim fill light inside the character's chest, which per pixel and unclamped
  burns a spotlight into the torso where the game lights the whole body evenly. A normal map or a specular
  highlight would need the per-pixel form back; nothing here has either.
- Under `staticCamera` the models are drawn inside the backdrop's own scene, in a single pass, so three.js
  depth-tests and sorts them against its batches the way the client's one scene does: scenery covers a model that
  stands behind it, and a translucent banner in front of one hangs in front of it — a translucent batch writes no
  depth, so in two passes it could only ever cover what the pass before it drew. The sort is coarser than the
  client's, which orders every batch by distance: three.js orders whole objects by their origin, and the backdrop
  is one object, as is each model, so translucent surfaces of a scene and a model that overlap can still stack
  wrongly. Under the orbit camera the backdrop stays a pass of its own with the depth buffer cleared after it, and
  the models draw on top of all of it.
- Under `staticCamera` the models are lit by the backdrop's own light set, as the glue screen lights them:
  `AddCharacterLight` and `AddPetLight` in `GlueParent.lua` are handed the same `RaceLights` rows as the scene
  itself, and the client lends every model in the scene its nearest point lights — `CM2Model::SetupLighting` calls
  `SelectLights` before the glue callback, whose `Reset()` clears the directional terms the scene set replaces and
  leaves the point lights alone. So the moonwell lights a night elf and the crypt braziers an undead, and a scene
  whose only row is a dim ambient leaves its character dim. Fog is not passed on, which is the client's doing too:
  only the background model is given any. Left out are the ghost lighting a dead character takes from `LightParams`
  row 3, and the ground shadow under the character. The four point lights are the first the backdrop carries rather
  than the four nearest the model, which only a scene with more than four could tell apart. Off a backdrop, and
  under the orbit camera, the models go back to the viewer's own ambient and single directional.
- `staticCamera` reproduces the character-selection view: the scene's camera, its attachment points, a facing of
  0.6° per pixel dragged, and the bone animation the scene turns and scales its attachment points with, all as the
  client does them. What it leaves out is the rest of that screen — the rotate buttons, the glue frame's fade, and
  the death-knight ghost lighting. A model's own `position` is ignored while it stands on an attachment, since the
  client gives it a rotation and a scale only.
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
