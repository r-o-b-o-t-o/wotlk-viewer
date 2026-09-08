import {
	createContext,
	createEffect,
	createMemo,
	createSignal,
	on,
	onCleanup,
	onMount,
	splitProps,
	useContext,
	type JSX,
	type ParentProps,
} from "solid-js";
import {
	CharacterBuilder,
	CreatureBuilder,
	GameData,
	M2Instance,
	mountInstance,
	Viewer,
	type AssetManager,
	type CharacterAppearance,
	type ViewerOptions,
} from "@wotlk-viewer/core";

const ViewerContext = createContext<() => Viewer | null>();

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
	const [local, rest] = splitProps(props, ["background", "antialias", "ref", "children"]);
	const [viewer, setViewer] = createSignal<Viewer | null>(null);
	let canvas!: HTMLCanvasElement;

	onMount(() => {
		const opts: ViewerOptions = { canvas, antialias: local.antialias };
		if (local.background !== undefined) opts.background = local.background;
		const v = new Viewer(opts);
		v.start();
		setViewer(v);
		local.ref?.(v);
		onCleanup(() => v.dispose());
	});

	// The canvas is part of the template so Solid's child reconciliation never removes it.
	return (
		<div
			class={rest.class}
			style={rest.style ?? { width: "100%", height: "100%", overflow: "hidden", position: "relative" }}
		>
			<canvas ref={canvas} style={{ display: "block", width: "100%", height: "100%" }} />
			<ViewerContext.Provider value={viewer}>{viewer() ? local.children : null}</ViewerContext.Provider>
		</div>
	);
}

/** The enclosing `WowViewer`'s viewer. */
export function useViewer(): Viewer {
	const v = useContext(ViewerContext)?.();
	if (!v) throw new Error("useViewer must be used inside <WowViewer>");
	return v;
}

interface InstanceProps {
	/** Animation id (AnimationData.dbc), default 0 (Stand). */
	animation?: number;
	loop?: boolean;
	/** Re-frame the camera when the model changes (default true). */
	autoFrame?: boolean;
	onLoad?: (instance: M2Instance) => void;
	onError?: (error: unknown) => void;
}

/** Shared loading/animation logic: reloads when `key()` changes, plays `props.animation`. */
function useInstance(load: () => Promise<M2Instance>, key: () => unknown, props: InstanceProps): void {
	const viewer = useViewer();
	const [instance, setInstance] = createSignal<M2Instance | null>(null);

	createEffect(
		on(key, () => {
			const unmount = mountInstance(viewer, load, {
				autoFrame: props.autoFrame,
				onLoad: (inst) => {
					setInstance(inst);
					props.onLoad?.(inst);
				},
				onError: (e) => props.onError?.(e),
			});
			onCleanup(() => {
				unmount();
				setInstance(null);
			});
		}),
	);

	createEffect(() => {
		const inst = instance();
		const anim = props.animation ?? 0;
		const loop = props.loop ?? true;
		if (inst) void inst.playAnimation(anim, { loop });
	});
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

export interface CreatureProps extends InstanceProps {
	assets: AssetManager;
	gameData?: GameData;
	/** CreatureDisplayInfo id. */
	displayId: number;
}

/** Displays a creature by display id (model, skin variation, scale). */
export function Creature(props: CreatureProps): JSX.Element {
	const viewer = useViewer();
	const data = createMemo(() => props.gameData ?? new GameData(props.assets));
	useInstance(
		() => new CreatureBuilder(props.assets, data(), viewer.lighting).build(props.displayId),
		() => props.displayId,
		props,
	);
	return null;
}
