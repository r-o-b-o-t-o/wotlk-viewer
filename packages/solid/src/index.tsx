import {
	createContext,
	createEffect,
	createMemo,
	createSignal,
	onSettled,
	Show,
	untrack,
	useContext,
	type ParentProps,
} from "solid-js";
import type { JSX } from "@solidjs/web";
import {
	BackdropBuilder,
	CharacterBuilder,
	CreatureBuilder,
	GameData,
	ItemBuilder,
	M2Instance,
	mountBackdrop,
	mountInstance,
	positionInstance,
	Viewer,
	type AssetManager,
	type CharacterAppearance,
	type InstancePosition,
	type ItemAppearance,
	type PetInfo,
	type ViewerOptions,
} from "@roboto_/wotlk-viewer-core";

const ViewerContext = createContext<Viewer>();

export interface WowViewerProps extends ParentProps {
	/** Clear color, null for transparent. */
	background?: number | null;
	antialias?: boolean;
	class?: string;
	style?: JSX.CSSProperties | string;
	/** Receives the viewer once created. */
	ref?: (viewer: Viewer) => void;
}

/** Hosts a canvas with a running `Viewer`; children get it through `useViewer()`. */
export function WowViewer(props: WowViewerProps): JSX.Element {
	const [viewer, setViewer] = createSignal<Viewer | null>(null);
	let canvas!: HTMLCanvasElement;

	onSettled(() => {
		// onSettled runs untracked, so these options are read once and never rebuild the viewer.
		const opts: ViewerOptions = { canvas, antialias: props.antialias };
		if (props.background !== undefined) opts.background = props.background;
		const v = new Viewer(opts);
		v.start();
		setViewer(v);
		props.ref?.(v);
		return () => v.dispose();
	});

	// The canvas is part of the template so Solid's child reconciliation never removes it.
	return (
		<div
			class={props.class}
			style={props.style ?? { width: "100%", height: "100%", overflow: "hidden", position: "relative" }}
		>
			<canvas ref={canvas} style={{ display: "block", width: "100%", height: "100%" }} />
			<Show when={viewer()} keyed>
				{(v) => <ViewerContext value={v}>{props.children}</ViewerContext>}
			</Show>
		</div>
	);
}

/** The enclosing `WowViewer`'s viewer; throws outside one. */
export function useViewer(): Viewer {
	return useContext(ViewerContext);
}

interface InstanceProps {
	/** Animation id (AnimationData.dbc), default 0 (Stand). */
	animation?: number;
	loop?: boolean;
	/** Where the model stands, default the origin. */
	position?: InstancePosition;
	/** Re-frame the camera when the model changes (default true). */
	autoFrame?: boolean;
	/** Frame and orbit the camera on this model's body alone, gear and everything else left out. */
	pivot?: boolean;
	/** Backdrop attachment this model stands on while the camera is fixed (see `Viewer.staticCamera`). */
	backdropAttachment?: number;
	onLoad?: (instance: M2Instance) => void;
	onError?: (error: unknown) => void;
}

/** Shared loading/animation logic: reloads when `key()` changes, plays `props.animation`. */
function useInstance(load: () => Promise<M2Instance>, key: () => unknown, props: InstanceProps): void {
	const viewer = useViewer();
	const [instance, setInstance] = createSignal<M2Instance | null>(null);
	// A memo so an equal key (same appearance, new object) does not reload.
	const loadKey = createMemo(key);

	createEffect(loadKey, () =>
		// Load options are read once per load; `position` alone follows changes, through the effect below.
		untrack(() => {
			const unmount = mountInstance(viewer, load, {
				position: props.position,
				autoFrame: props.autoFrame,
				pivot: props.pivot,
				backdropAttachment: props.backdropAttachment,
				onLoad: (inst) => {
					setInstance(inst);
					props.onLoad?.(inst);
				},
				onError: (e) => props.onError?.(e),
			});
			return () => {
				unmount();
				setInstance(null);
			};
		}),
	);

	createEffect(
		() => ({ inst: instance(), anim: props.animation ?? 0, loop: props.loop ?? true }),
		({ inst, anim, loop }) => {
			if (inst) void inst.playAnimation(anim, { loop });
		},
	);

	createEffect(
		() => [instance(), props.position] as const,
		([inst, pos]) => {
			if (inst && pos) positionInstance(inst, pos);
		},
	);
}

export interface ModelProps extends InstanceProps {
	assets: AssetManager;
	/** Client path of an .m2 file. */
	path: string;
}

/** Loads and displays a plain M2 model in the enclosing viewer. */
export function Model(props: ModelProps): JSX.Element {
	const viewer = useViewer();
	useInstance(
		async () => M2Instance.create(await props.assets.loadModel(props.path), props.assets, viewer.lighting),
		() => props.path,
		props,
	);
	return null;
}

export interface CharacterProps extends InstanceProps {
	assets: AssetManager;
	/** Shared DBC access; created from `assets` when omitted. */
	gameData?: GameData;
	appearance: CharacterAppearance;
}

/** Builds and displays a player character in the enclosing viewer. */
export function Character(props: CharacterProps): JSX.Element {
	const viewer = useViewer();
	const data = createMemo(() => props.gameData ?? new GameData(props.assets));
	useInstance(
		() => new CharacterBuilder(props.assets, data(), viewer.lighting).build(props.appearance),
		() => JSON.stringify(props.appearance),
		props,
	);
	return null;
}

export interface BackdropProps {
	assets: AssetManager;
	gameData?: GameData;
	/** ChrRaces id; the scene shown is the one that race's character-creation screen uses. */
	race: number;
	/** Class id; death knights get their own scene whatever their race. */
	classId?: number;
	/**
	 * Show the models through the scene's own camera, standing where it stands them, as the
	 * character-selection screen does; a left-drag then turns the character (default true).
	 */
	staticCamera?: boolean;
	onError?: (error: unknown) => void;
}

/**
 * Shows a character's character-creation scene behind the models. The scene keeps its own camera, so
 * the mouse controls leave it alone and it always faces the viewer.
 */
export function Backdrop(props: BackdropProps): JSX.Element {
	const viewer = useViewer();
	const data = createMemo(() => props.gameData ?? new GameData(props.assets));
	createEffect(
		() => [props.race, props.classId, props.staticCamera] as const,
		([race, classId, staticCamera]) =>
			untrack(() =>
				mountBackdrop(
					viewer,
					() => new BackdropBuilder(props.assets, data(), viewer.backdropLighting).build(race, classId),
					{
						staticCamera,
						onError: (e) => props.onError?.(e),
					},
				),
			),
	);
	return null;
}

export interface CreatureProps extends InstanceProps {
	assets: AssetManager;
	gameData?: GameData;
	/** CreatureDisplayInfo id. */
	displayId: number;
	/** Set when the creature is a character's pet, which the client sizes by its family. */
	pet?: PetInfo;
}

/** Displays a creature by display id (model, skin variation, scale). */
export function Creature(props: CreatureProps): JSX.Element {
	const viewer = useViewer();
	const data = createMemo(() => props.gameData ?? new GameData(props.assets));
	useInstance(
		() => new CreatureBuilder(props.assets, data(), viewer.lighting).build(props.displayId, props.pet),
		() => `${props.displayId}|${props.pet?.family}|${props.pet?.level}`,
		props,
	);
	return null;
}

export interface ItemProps extends InstanceProps {
	assets: AssetManager;
	gameData?: GameData;
	item: ItemAppearance;
}

/** Displays one item model on its own — a weapon, shield, helm, shoulder or quiver. */
export function Item(props: ItemProps): JSX.Element {
	const viewer = useViewer();
	const data = createMemo(() => props.gameData ?? new GameData(props.assets));
	useInstance(
		() => new ItemBuilder(props.assets, data(), viewer.lighting).build(props.item),
		() => JSON.stringify(props.item),
		props,
	);
	return null;
}
