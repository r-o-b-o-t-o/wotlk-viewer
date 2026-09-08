import type { M2Instance } from "./M2Instance.js";
import type { Viewer } from "./Viewer.js";

export interface MountOptions {
	/** Re-frame the camera once the instance is in the scene (default true). */
	autoFrame?: boolean;
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
			viewer.add(inst);
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
