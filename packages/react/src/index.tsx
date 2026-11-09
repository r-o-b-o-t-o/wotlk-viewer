import { createContext, useContext, useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
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

const ViewerContext = createContext<Viewer | null>(null);

export interface WowViewerProps {
	/** Clear color, null for transparent. */
	background?: number | null;
	antialias?: boolean;
	className?: string;
	style?: CSSProperties;
	/** Receives the viewer once created. */
	onViewer?: (viewer: Viewer) => void;
	children?: ReactNode;
}

/** Hosts a canvas with a running `Viewer`; children get it through `useViewer()`. */
export function WowViewer({ background, antialias, className, style, onViewer, children }: WowViewerProps) {
	const canvas = useRef<HTMLCanvasElement>(null);
	const [viewer, setViewer] = useState<Viewer | null>(null);

	useEffect(() => {
		const opts: ViewerOptions = { canvas: canvas.current!, antialias };
		if (background !== undefined) opts.background = background;
		const v = new Viewer(opts);
		v.start();
		setViewer(v);
		onViewer?.(v);
		return () => {
			v.dispose();
			setViewer(null);
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	return (
		<div
			className={className}
			style={style ?? { width: "100%", height: "100%", overflow: "hidden", position: "relative" }}
		>
			<canvas ref={canvas} style={{ display: "block", width: "100%", height: "100%" }} />
			<ViewerContext.Provider value={viewer}>{viewer ? children : null}</ViewerContext.Provider>
		</div>
	);
}

/** The enclosing `WowViewer`'s viewer. */
export function useViewer(): Viewer {
	const v = useContext(ViewerContext);
	if (!v) throw new Error("useViewer must be used inside <WowViewer>");
	return v;
}

interface InstanceProps {
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

/** Shared loading/animation logic for `Model`, `Character` and `Creature`. */
function useInstance(load: () => Promise<M2Instance>, deps: unknown[], props: InstanceProps) {
	const viewer = useViewer();
	const [instance, setInstance] = useState<M2Instance | null>(null);

	useEffect(() => {
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
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, deps);

	useEffect(() => {
		if (instance) void instance.playAnimation(props.animation ?? 0, { loop: props.loop ?? true });
	}, [instance, props.animation, props.loop]);

	useEffect(() => {
		if (instance && props.position) positionInstance(instance, props.position);
	}, [instance, props.position]);
}

export interface ModelProps extends InstanceProps {
	assets: AssetManager;
	/** Client path of an .m2 file. */
	path: string;
}

/** Loads and displays a plain M2 model in the enclosing viewer. */
export function Model(props: ModelProps) {
	const viewer = useViewer();
	useInstance(
		async () => M2Instance.create(await props.assets.loadModel(props.path), props.assets, viewer.lighting),
		[props.path],
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
export function Character(props: CharacterProps) {
	const viewer = useViewer();
	const data = useRef<GameData | null>(null);
	useInstance(
		() => {
			data.current ??= props.gameData ?? new GameData(props.assets);
			return new CharacterBuilder(props.assets, data.current, viewer.lighting).build(props.appearance);
		},
		[JSON.stringify(props.appearance)],
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
export function Backdrop(props: BackdropProps) {
	const viewer = useViewer();
	const data = useRef<GameData | null>(null);
	useEffect(() => {
		data.current ??= props.gameData ?? new GameData(props.assets);
		return mountBackdrop(
			viewer,
			() =>
				new BackdropBuilder(props.assets, data.current!, viewer.backdropLighting).build(
					props.race,
					props.classId,
				),
			{ staticCamera: props.staticCamera, onError: (e) => props.onError?.(e) },
		);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [props.race, props.classId, props.staticCamera]);
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
export function Creature(props: CreatureProps) {
	const viewer = useViewer();
	const data = useRef<GameData | null>(null);
	useInstance(
		() => {
			data.current ??= props.gameData ?? new GameData(props.assets);
			return new CreatureBuilder(props.assets, data.current, viewer.lighting).build(props.displayId, props.pet);
		},
		[props.displayId, props.pet?.family, props.pet?.level],
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
export function Item(props: ItemProps) {
	const viewer = useViewer();
	const data = useRef<GameData | null>(null);
	useInstance(
		() => {
			data.current ??= props.gameData ?? new GameData(props.assets);
			return new ItemBuilder(props.assets, data.current, viewer.lighting).build(props.item);
		},
		[JSON.stringify(props.item)],
		props,
	);
	return null;
}
