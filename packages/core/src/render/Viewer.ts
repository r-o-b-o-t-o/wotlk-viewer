import {
	Box3,
	Color,
	Group,
	LinearSRGBColorSpace,
	MathUtils,
	PerspectiveCamera,
	Scene,
	Vector3,
	Vector4,
	WebGLRenderer,
} from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { M2_MAX_LIGHTS, type M2Lighting } from "./M2Material.js";
import type { M2Instance } from "./M2Instance.js";

export interface ViewerOptions {
	/** Canvas to render into; created inside `container` when omitted. */
	canvas?: HTMLCanvasElement;
	container?: HTMLElement;
	/** Clear color; null for a transparent canvas. */
	background?: number | null;
	antialias?: boolean;
}

/** The light set of a backdrop scene, in the model's own space (see `Viewer.setBackdrop`). */
export interface BackdropLighting {
	/** Ambient term for the whole scene. */
	ambient: [number, number, number];
	/** Directional lights; `direction` is the way the light travels, so it faces the lit surfaces. */
	lights: { direction: [number, number, number]; color: [number, number, number] }[];
	/** Linear fog, if the scene has any: its colour and the distance at which it is complete. */
	fog?: { color: [number, number, number]; end: number };
}

/** Share of the pending zoom spent per frame; OrbitControls damps rotation and panning the same way. */
const ZOOM_DAMPING = 0.08;
/** Pending zoom below this is not worth another frame of easing. */
const ZOOM_EPSILON = 1e-4;
/** Narrowest frame a backdrop is composed for; the client's own minimum was 4:3. */
const MIN_BACKDROP_ASPECT = 4 / 3;
/** Log-distance change per wheel notch and per pixel of ctrl-drag. */
const WHEEL_ZOOM_SPEED = 0.0015;
const DRAG_ZOOM_SPEED = 0.006;
const tmpOffset = new Vector3();
const tmpEye = new Vector3();
const tmpTarget = new Vector3();

/** Turns a point or direction in WoW's Z-up space into the scene's Y-up one, as `root` does. */
function zUpToScene(v: [number, number, number] | ArrayLike<number>, out: Vector3): Vector3 {
	return out.set(v[0], v[2], -v[1]);
}

/**
 * Minimal scene setup: renderer, orbit camera, lighting and a render loop that updates M2 instances.
 * Instances are placed under `root`, which converts WoW's Z-up space to three.js Y-up.
 */
export class Viewer {
	readonly renderer: WebGLRenderer;
	readonly scene = new Scene();
	readonly camera: PerspectiveCamera;
	readonly controls: OrbitControls;
	/** Z-up parent for M2 instances. */
	readonly root = new Group();
	readonly instances: M2Instance[] = [];
	/**
	 * Instance the camera frames and orbits on, its own body alone. Without one it uses every
	 * instance and everything attached to them, which drags the pivot off a character towards its
	 * pet and its weapons.
	 */
	pivot: M2Instance | null = null;
	readonly lighting: M2Lighting = {
		ambient: new Vector3(0.55, 0.55, 0.55),
		lights: [{ color: new Vector3(0.7, 0.7, 0.7), direction: new Vector3(0.3, 0.6, 0.75).normalize() }],
		fog: new Vector4(0, 0, 0, 0), // a bare Vector4 has w = 1, which would fog the scene solid
	};
	/** Scene holding the backdrop, drawn before `scene` through `backdropCamera`. */
	readonly backdropScene = new Scene();
	/** The backdrop's own camera, fixed where its scene was composed; mouse controls never touch it. */
	readonly backdropCamera = new PerspectiveCamera();
	/** Lighting of the backdrop alone, in its camera's view space; `setBackdrop` fills it in. */
	readonly backdropLighting: M2Lighting = {
		ambient: new Vector3(),
		lights: Array.from({ length: M2_MAX_LIGHTS }, () => ({ color: new Vector3(), direction: new Vector3() })),
		fog: new Vector4(0, 0, 0, 0), // a bare Vector4 has w = 1, which would fog the scene solid
	};
	/** Animation speed multiplier; 0 pauses. */
	timeScale = 1;

	/** Z-up parent for the backdrop, matching `root`. */
	private readonly backdropRoot = new Group();
	private backdrop: M2Instance | null = null;
	/** The backdrop camera's diagonal field of view; `resize` derives a vertical one from it. */
	private backdropFov = 0;
	private raf = 0;
	private lastTime = 0;
	private readonly resizeObserver: ResizeObserver | null = null;
	/** Zoom still to be eased out, as a log distance change. */
	private pendingZoom = 0;

	constructor(opts: ViewerOptions = {}) {
		const canvas = opts.canvas ?? document.createElement("canvas");
		if (!opts.canvas) {
			canvas.style.cssText = "display:block;width:100%;height:100%";
			(opts.container ?? document.body).appendChild(canvas);
		}
		this.renderer = new WebGLRenderer({
			canvas,
			antialias: opts.antialias ?? true,
			alpha: opts.background === null,
		});
		this.renderer.outputColorSpace = LinearSRGBColorSpace; // shading is done in gamma space
		this.renderer.setPixelRatio(window.devicePixelRatio);
		// The clear colour rather than a scene background: three.js clears the depth buffer along with
		// a scene's background colour, which would wipe out the backdrop pass.
		this.renderer.setClearColor(
			new Color().setHex(opts.background ?? 0x2a2d33, LinearSRGBColorSpace),
			opts.background === null ? 0 : 1,
		);

		this.camera = new PerspectiveCamera(45, 1, 0.05, 500);
		this.camera.position.set(4, 1.5, 0);
		this.bindZoom(canvas);
		this.controls = new OrbitControls(this.camera, canvas);
		this.controls.target.set(0, 1, 0);
		this.controls.enableDamping = true;
		this.controls.enableZoom = false; // zoomed by hand below, with inertia
		this.controls.minDistance = 0.25; // never reach the target, which leaves no direction to zoom back out along

		this.root.rotation.x = -Math.PI / 2;
		this.scene.add(this.root);
		this.backdropRoot.rotation.x = -Math.PI / 2;
		this.backdropScene.add(this.backdropRoot);

		const host = canvas.parentElement ?? canvas;
		this.resizeObserver = new ResizeObserver(() => this.resize());
		this.resizeObserver.observe(host);
		this.resize();
	}

	get canvas(): HTMLCanvasElement {
		return this.renderer.domElement;
	}

	/**
	 * Wheel and ctrl + vertical drag feed `pendingZoom`, which `render()` eases out.
	 * Must be bound before OrbitControls so the ctrl-drag can be swallowed: OrbitControls treats
	 * every modifier as "pan", and listeners on the same element run in registration order.
	 */
	private bindZoom(canvas: HTMLCanvasElement): void {
		let dragging = false;
		let lastY = 0;
		canvas.addEventListener("pointerdown", (e) => {
			if (e.button !== 0 || !e.ctrlKey) return;
			e.stopImmediatePropagation();
			dragging = true;
			lastY = e.clientY;
			canvas.setPointerCapture(e.pointerId);
		});
		canvas.addEventListener("pointermove", (e) => {
			if (!dragging) return;
			this.pendingZoom += (e.clientY - lastY) * DRAG_ZOOM_SPEED;
			lastY = e.clientY;
		});
		const stop = () => (dragging = false);
		canvas.addEventListener("pointerup", stop);
		canvas.addEventListener("pointercancel", stop);
		canvas.addEventListener(
			"wheel",
			(e) => {
				e.preventDefault();
				this.pendingZoom += e.deltaY * WHEEL_ZOOM_SPEED;
			},
			{ passive: false },
		);
	}

	/** Spends part of the pending zoom; OrbitControls picks the new distance up and clamps it. */
	private applyZoom(): void {
		if (Math.abs(this.pendingZoom) < ZOOM_EPSILON) {
			this.pendingZoom = 0;
			return;
		}
		const step = this.pendingZoom * ZOOM_DAMPING;
		this.pendingZoom -= step;
		tmpOffset.subVectors(this.camera.position, this.controls.target);
		this.camera.position.addVectors(this.controls.target, tmpOffset.multiplyScalar(Math.exp(step)));
	}

	add(instance: M2Instance): void {
		this.instances.push(instance);
		this.root.add(instance);
	}

	remove(instance: M2Instance): void {
		const i = this.instances.indexOf(instance);
		if (i >= 0) this.instances.splice(i, 1);
		if (this.pivot === instance) this.pivot = null;
		this.root.remove(instance);
	}

	/**
	 * Shows `instance` behind the models, seen through the camera baked into its model — the view the
	 * scene was composed for. It never moves, so orbiting or zooming the subject leaves the backdrop
	 * exactly where it is. Pass null to take it away; the caller keeps ownership either way.
	 */
	setBackdrop(instance: M2Instance | null, lighting?: BackdropLighting): void {
		if (this.backdrop) this.backdropRoot.remove(this.backdrop);
		this.backdrop = null;
		if (!instance) return;
		const cam = instance.model.m2.cameras[0];
		if (!cam) {
			console.warn(`Backdrop ${instance.model.path} carries no camera, so there is no view to show it from.`);
			return;
		}
		this.backdrop = instance;
		this.backdropRoot.add(instance);
		this.backdropFov = cam.fov;
		this.backdropCamera.near = cam.nearClip;
		this.backdropCamera.far = cam.farClip;
		this.backdropCamera.position.copy(zUpToScene(cam.position, tmpEye));
		this.backdropCamera.up.set(0, 1, 0);
		this.backdropCamera.lookAt(zUpToScene(cam.target, tmpTarget));
		this.backdropCamera.updateMatrixWorld();
		this.backdropCamera.matrixWorldInverse.copy(this.backdropCamera.matrixWorld).invert();
		this.updateBackdropProjection();
		this.applyBackdropLighting(lighting);
	}

	/** Turns a backdrop's light set into the view-space one its materials already read. */
	private applyBackdropLighting(lighting: BackdropLighting | undefined): void {
		// Without a light set, leave the scene at full brightness rather than in the dark.
		this.backdropLighting.ambient.fromArray(lighting?.ambient ?? [1, 1, 1]);
		const fog = lighting?.fog;
		this.backdropLighting.fog.set(...(fog?.color ?? [0, 0, 0]), fog?.end ?? 0);
		this.backdropLighting.lights.forEach((slot, i) => {
			const light = lighting?.lights[i];
			if (!light) {
				// An unused slot still needs a real direction: normalizing a zero vector leaves NaN
				// behind, and that spreads through the shading even when multiplied by black.
				slot.color.setScalar(0);
				slot.direction.set(0, 0, 1);
				return;
			}
			slot.color.fromArray(light.color);
			// The client stores the way the light travels; shading wants the way back towards it.
			zUpToScene(light.direction, slot.direction)
				.negate()
				.transformDirection(this.backdropCamera.matrixWorldInverse);
		});
	}

	/** The client reads a camera's diagonal FOV as a vertical one for the aspect it is drawn at. */
	private updateBackdropProjection(): void {
		this.backdropCamera.aspect = this.camera.aspect;
		// A frame taller than the client ever ran at would look further up than the scene reaches and
		// leave a band of empty sky, so a narrow viewport crops the sides instead.
		const aspect = Math.max(this.camera.aspect, MIN_BACKDROP_ASPECT);
		this.backdropCamera.fov = MathUtils.radToDeg(this.backdropFov / Math.sqrt(1 + aspect ** 2));
		this.backdropCamera.updateProjectionMatrix();
	}

	clear(dispose = true): void {
		for (const inst of [...this.instances]) {
			this.remove(inst);
			if (dispose) inst.dispose();
		}
	}

	/**
	 * Points the camera at the instances' bounds (attached models included), or at `pivot`'s own
	 * body when one is set. A pet beside it or a polearm in its hand may then start partly out of
	 * frame, which is better than moving the camera off the subject to make room.
	 */
	frame(padding = 1.3): void {
		if (this.instances.length === 0) return;
		this.camera.updateMatrixWorld();
		this.scene.updateMatrixWorld(true);
		// Attached models only get their matrix inside update(), which may not have run yet.
		for (const inst of this.instances) inst.update(0, this.camera);
		const box = new Box3();
		const addBody = (inst: M2Instance, target: Box3) => {
			// Bind-pose geometry bounds; the M2 bounding box is often much looser.
			const g = inst.model.geometry;
			if (!g.boundingBox) g.computeBoundingBox();
			target.union(g.boundingBox!.clone().applyMatrix4(inst.matrixWorld));
		};
		const addWithAttached = (inst: M2Instance, target: Box3) => {
			addBody(inst, target);
			for (const a of inst.attached) addWithAttached(a.instance, target);
		};
		if (this.pivot && this.instances.includes(this.pivot)) {
			// Body only: a two-hander reaches twice as far as the character carrying it, so letting
			// gear into the box would re-frame the same character every time the weapon changed.
			addBody(this.pivot, box);
		} else {
			for (const inst of this.instances) addWithAttached(inst, box);
		}
		const center = box.getCenter(new Vector3());
		const size = box.getSize(new Vector3());
		const radius = Math.max(size.x, size.y, size.z) * 0.5 * padding;
		// Fit the height in the vertical FOV, or the width in the horizontal one.
		const vFov = (this.camera.fov * Math.PI) / 360;
		const hFov = Math.atan(Math.tan(vFov) * this.camera.aspect);
		const dist = Math.max(
			(size.y * 0.5 * padding) / Math.tan(vFov),
			(Math.max(size.x, size.z) * 0.5 * padding) / Math.tan(hFov),
			radius * 0.5,
		);
		this.controls.target.copy(center);
		this.camera.position.set(center.x + dist, center.y + radius * 0.15, center.z);
		this.pendingZoom = 0; // a leftover from the previous model would drift out of the new frame
		this.controls.update();
	}

	resize(): void {
		const el = this.canvas.parentElement ?? this.canvas;
		const w = el.clientWidth || 1;
		const h = el.clientHeight || 1;
		this.renderer.setSize(w, h, false);
		this.camera.aspect = w / h;
		this.camera.updateProjectionMatrix();
		if (this.backdrop) this.updateBackdropProjection();
	}

	/** Renders one frame, advancing animations by `dtMs`. */
	render(dtMs = 0): void {
		this.applyZoom();
		this.controls.update();
		this.camera.updateMatrixWorld();
		this.root.updateMatrixWorld(true);
		for (const inst of this.instances) inst.update(dtMs * this.timeScale, this.camera);
		if (!this.backdrop) return this.renderer.render(this.scene, this.camera);
		this.backdropRoot.updateMatrixWorld(true);
		this.backdrop.update(dtMs * this.timeScale, this.backdropCamera);
		// Two passes with the depth buffer cleared between them: the backdrop keeps the depths its own
		// scene was built at, and the models always draw in front of all of it.
		this.renderer.autoClear = false;
		this.renderer.clear();
		this.renderer.render(this.backdropScene, this.backdropCamera);
		this.renderer.clearDepth();
		this.renderer.render(this.scene, this.camera);
		this.renderer.autoClear = true;
	}

	start(): void {
		if (this.raf) return;
		this.lastTime = performance.now();
		const tick = (now: number) => {
			const dt = Math.min(now - this.lastTime, 100);
			this.lastTime = now;
			this.render(dt);
			this.raf = requestAnimationFrame(tick);
		};
		this.raf = requestAnimationFrame(tick);
	}

	stop(): void {
		cancelAnimationFrame(this.raf);
		this.raf = 0;
	}

	dispose(): void {
		this.stop();
		this.resizeObserver?.disconnect();
		this.setBackdrop(null);
		this.clear();
		this.controls.dispose();
		this.renderer.dispose();
	}
}
