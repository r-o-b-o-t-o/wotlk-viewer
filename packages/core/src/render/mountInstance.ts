import type { M2Instance } from "./M2Instance.js";
import type { Viewer } from "./Viewer.js";

/**
 * Where an instance stands, in the viewer's Z-up space. A function is called with the loaded
 * instance, for placements that depend on how big the model turned out to be (see `petPosition`).
 */
export type InstancePosition = [number, number, number] | ((instance: M2Instance) => [number, number, number]);

/** Moves `instance` to `position`, resolving the function form. */
export function positionInstance(instance: M2Instance, position: InstancePosition): void {
	instance.position.fromArray(typeof position === "function" ? position(instance) : position);
}

export interface MountOptions {
	/** Placement, applied before framing; default the origin. */
	position?: InstancePosition;
	/** Re-frame the camera once the instance is in the scene (default true). */
	autoFrame?: boolean;
	/** Make this instance the one the camera frames and orbits on, body alone (see `Viewer.pivot`). */
	pivot?: boolean;
	/** Backdrop attachment this instance stands on while the camera is fixed (see `Viewer.staticCamera`). */
	backdropAttachment?: number;
	onLoad?: (instance: M2Instance) => void;
	onError?: (error: unknown) => void;
}

/**
 * Loads an instance and adds it to `viewer`. Returns a disposer that cancels a load still in
 * flight, or removes and disposes the instance once it arrived. UI bindings call this from
 * whatever effect their framework provides.
 */
export function mountInstance(viewer: Viewer, load: () => Promise<M2Instance>, opts: MountOptions = {}): () => void {
	let cancelled = false;
	let instance: M2Instance | null = null;
	load().then(
		(inst) => {
			if (cancelled) return inst.dispose();
			instance = inst;
			if (opts.position) positionInstance(inst, opts.position);
			viewer.add(inst);
			if (opts.backdropAttachment !== undefined) viewer.setBackdropAttachment(inst, opts.backdropAttachment);
			if (opts.pivot) viewer.pivot = inst;
			if (opts.autoFrame ?? true) viewer.frame();
			opts.onLoad?.(inst);
		},
		(e) => {
			if (!cancelled) opts.onError?.(e);
		},
	);
	return () => {
		cancelled = true;
		if (instance) {
			viewer.remove(instance);
			instance.dispose();
			instance = null;
		}
	};
}
