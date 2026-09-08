import {
  createContext, useContext, useEffect, useRef, useState, type CSSProperties, type ReactNode,
} from 'react';
import {
  CharacterBuilder, GameData, M2Instance, Viewer, type AssetManager, type CharacterAppearance, type ViewerOptions,
} from '@wotlk-viewer/core';

const ViewerContext = createContext<Viewer | null>(null);

export interface WowViewerProps {
  assets: AssetManager;
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
export function WowViewer({ assets, background, antialias, className, style, onViewer, children }: WowViewerProps) {
  const container = useRef<HTMLDivElement>(null);
  const [viewer, setViewer] = useState<Viewer | null>(null);
  void assets;

  useEffect(() => {
    const opts: ViewerOptions = { container: container.current!, antialias };
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
    <div ref={container} className={className} style={style ?? { width: '100%', height: '100%', overflow: 'hidden', position: 'relative' }}>
      <ViewerContext.Provider value={viewer}>{viewer ? children : null}</ViewerContext.Provider>
    </div>
  );
}

/** The enclosing `WowViewer`'s viewer. */
export function useViewer(): Viewer {
  const v = useContext(ViewerContext);
  if (!v) throw new Error('useViewer must be used inside <WowViewer>');
  return v;
}

interface InstanceProps {
  animation?: number;
  loop?: boolean;
  /** Re-frame the camera when the model changes (default true). */
  autoFrame?: boolean;
  onLoad?: (instance: M2Instance) => void;
  onError?: (error: unknown) => void;
}

/** Shared loading/animation logic for `Model` and `Character`. */
function useInstance(load: () => Promise<M2Instance>, deps: unknown[], props: InstanceProps) {
  const viewer = useViewer();
  const [instance, setInstance] = useState<M2Instance | null>(null);

  useEffect(() => {
    let cancelled = false;
    let inst: M2Instance | null = null;
    load().then(
      (i) => {
        if (cancelled) return i.dispose();
        inst = i;
        viewer.add(i);
        setInstance(i);
        if (props.autoFrame ?? true) viewer.frame();
        props.onLoad?.(i);
      },
      (e) => { if (!cancelled) props.onError?.(e); },
    );
    return () => {
      cancelled = true;
      if (inst) {
        viewer.remove(inst);
        inst.dispose();
        setInstance(null);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  useEffect(() => {
    if (instance) void instance.playAnimation(props.animation ?? 0, { loop: props.loop ?? true });
  }, [instance, props.animation, props.loop]);
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
