import {
	Box3,
	Color,
	Group,
	LinearSRGBColorSpace,
	MathUtils,
	Matrix4,
	PerspectiveCamera,
	Quaternion,
	Scene,
	Vector3,
	Vector4,
	WebGLRenderer,
} from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { M2LightType } from "../formats/m2.js";
import { M2_MAX_LIGHTS, M2_MAX_POINT_LIGHTS, type M2DirectionalLight, type M2Lighting } from "./M2Material.js";
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

/**
 * The attachment points a glue-screen backdrop carries, as the client's character-selection and
 * character-creation screens use them: the character stands on the first, its pet on the second.
 */
export const BACKDROP_CHARACTER_ATTACHMENT = 0;
export const BACKDROP_PET_ATTACHMENT = 1;

/**
 * Where a backdrop's meshes sit in the render order: below every model that stands in it, attached
 * items and their visual effects included. Three.js sorts translucent meshes by render order before
 * depth, so a backdrop left level with the models drew after everything sorted below it, and its own
 * translucent batches — foliage, mostly — painted over a weapon's glow however far behind it stood.
 * Standing the whole backdrop first is the trade in the other direction, see docs/known-limitations.md.
 */
const BACKDROP_RENDER_ORDER = -1000;

/** Share of the pending zoom spent per frame; OrbitControls damps rotation and panning the same way. */
const ZOOM_DAMPING = 0.08;
/** Pending zoom below this is not worth another frame of easing. */
const ZOOM_EPSILON = 1e-4;
/** Narrowest frame a backdrop is composed for; the client's own minimum was 4:3. */
const MIN_BACKDROP_ASPECT = 4 / 3;
/** Log-distance change per wheel notch and per pixel of ctrl-drag. */
const WHEEL_ZOOM_SPEED = 0.0015;
const DRAG_ZOOM_SPEED = 0.006;
/**
 * Degrees a character turns per pixel of drag, as `CHARACTER_ROTATION_CONSTANT` in the client's
 * `Interface\GlueXML\CharacterSelect.lua`.
 */
const FACING_PER_PIXEL = 0.6;
const tmpOffset = new Vector3();
const tmpEye = new Vector3();
const tmpTarget = new Vector3();
/** The viewer's own light set, copied into the models' lighting whenever no backdrop lights them. */
const DEFAULT_AMBIENT = new Vector3(0.55, 0.55, 0.55);
const DEFAULT_LIGHTS: M2DirectionalLight[] = [
	{ color: new Vector3(0.7, 0.7, 0.7), direction: new Vector3(0.3, 0.6, 0.75).normalize() },
];
const tmpMatrix = new Matrix4();
const tmpAttachment = new Matrix4();
const tmpLocal = new Matrix4();
const tmpQuat = new Quaternion();
const tmpZ = new Vector3(0, 0, 1);
const ORIGIN = new Vector3();

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
	/**
	 * Lighting of the models. Every slot is allocated up front, black where unused: a material binds
	 * these vectors once, so a light set swapped in later (see `staticCamera`) has to land in them.
	 */
	readonly lighting: M2Lighting = {
		ambient: DEFAULT_AMBIENT.clone(),
		lights: Array.from({ length: M2_MAX_LIGHTS }, (_, i) => ({
			color: DEFAULT_LIGHTS[i]?.color.clone() ?? new Vector3(),
			// An unused slot still needs a real direction, since the shader normalizes none of them.
			direction: DEFAULT_LIGHTS[i]?.direction.clone() ?? new Vector3(0, 0, 1),
		})),
		points: Array.from({ length: M2_MAX_POINT_LIGHTS }, () => ({ color: new Vector3(), position: new Vector3() })),
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
		points: Array.from({ length: M2_MAX_POINT_LIGHTS }, () => ({ color: new Vector3(), position: new Vector3() })),
		fog: new Vector4(0, 0, 0, 0), // a bare Vector4 has w = 1, which would fog the scene solid
	};
	/** Animation speed multiplier; 0 pauses. */
	timeScale = 1;
	/** How far the character has been turned, in radians about its own up axis. */
	facing = 0;

	/** Z-up parent for the backdrop, matching `root`. */
	private readonly backdropRoot = new Group();
	private backdrop: M2Instance | null = null;
	/** Backdrop attachment each instance stands at while the camera is fixed (see `staticCamera`). */
	private readonly backdropAttachments = new Map<M2Instance, number>();
	private fixedCamera = false;
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
		this.bindFacing(canvas);
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
	 * Shows the models through the backdrop's own camera, standing where its scene stands them, the
	 * way the character-selection screen does: the camera never moves, and a left-drag turns the
	 * character instead of orbiting it. Ignored until a backdrop is set (see `setBackdrop`).
	 */
	get staticCamera(): boolean {
		return this.fixedCamera;
	}

	set staticCamera(on: boolean) {
		if (on === this.fixedCamera) return;
		this.fixedCamera = on;
		this.pendingZoom = 0;
		this.facing = 0;
		this.syncPlacement();
	}

	/**
	 * Which of the backdrop's attachment points an instance stands at while `staticCamera` is on —
	 * `BACKDROP_CHARACTER_ATTACHMENT` for the character, `BACKDROP_PET_ATTACHMENT` for its pet. Its
	 * own `position` is then ignored, as the client ignores it; pass null to place it freely again.
	 */
	setBackdropAttachment(instance: M2Instance, attachmentId: number | null): void {
		if (attachmentId === null) this.backdropAttachments.delete(instance);
		else this.backdropAttachments.set(instance, attachmentId);
		this.syncPlacement();
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
			if (e.button !== 0 || !e.ctrlKey || this.fixedCamera) return;
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
				if (!this.fixedCamera) this.pendingZoom += e.deltaY * WHEEL_ZOOM_SPEED;
			},
			{ passive: false },
		);
	}

	/**
	 * Left-drag turns the character while the camera is fixed, at the glue screens' own rate of 0.6°
	 * per pixel — half a turn across 300 of them. OrbitControls is disabled in that mode, so both can
	 * watch the same button.
	 */
	private bindFacing(canvas: HTMLCanvasElement): void {
		let dragging = false;
		let lastX = 0;
		canvas.addEventListener("pointerdown", (e) => {
			if (e.button !== 0 || !this.fixedCamera) return;
			dragging = true;
			lastX = e.clientX;
			canvas.setPointerCapture(e.pointerId);
		});
		canvas.addEventListener("pointermove", (e) => {
			if (!dragging) return;
			this.facing += MathUtils.degToRad((e.clientX - lastX) * FACING_PER_PIXEL);
			lastX = e.clientX;
		});
		const stop = () => (dragging = false);
		canvas.addEventListener("pointerup", stop);
		canvas.addEventListener("pointercancel", stop);
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
		this.backdropAttachments.delete(instance);
		instance.matrixAutoUpdate = true;
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
		if (!instance) return this.syncPlacement();
		const cam = instance.model.m2.cameras[0];
		if (!cam) {
			console.warn(`Backdrop ${instance.model.path} carries no camera, so there is no view to show it from.`);
			return this.syncPlacement();
		}
		this.backdrop = instance;
		instance.setRenderOrder(BACKDROP_RENDER_ORDER);
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
		this.syncPlacement();
	}

	/** Whether a backdrop is the one standing, lighting and looking at the models (see `staticCamera`). */
	private get onBackdrop(): boolean {
		return this.fixedCamera && this.backdrop !== null;
	}

	/**
	 * Hands the models over to the backdrop, or takes them back: its scene, so that one pass sorts
	 * them against its batches, its light set, and its attachment points, whose matrices
	 * `placeOnBackdrop` writes in place of three.js. `staticCamera` set while a scene is still
	 * loading changes nothing until it arrives, so one that never does leaves the controls alone.
	 */
	private syncPlacement(): void {
		const on = this.onBackdrop;
		this.controls.enabled = !on;
		for (const inst of this.instances) inst.matrixAutoUpdate = !(on && this.backdropAttachments.has(inst));
		const scene = on ? this.backdropScene : this.scene;
		if (this.root.parent !== scene) scene.add(this.root);
		this.applyModelLighting();
	}

	/**
	 * Lights the models with the backdrop's own light set while they stand in its scene, which is what
	 * the glue screen does: `AddCharacterLight` and `AddPetLight` take the same `RaceLights` rows as
	 * the scene itself. Its fog stays out, which is the client's doing too — only the background model
	 * is given any. Off a backdrop the models go back to the viewer's own light set.
	 */
	private applyModelLighting(): void {
		const scene = this.onBackdrop ? this.backdropLighting : null;
		this.lighting.ambient.copy(scene ? scene.ambient : DEFAULT_AMBIENT);
		this.lighting.lights.forEach((slot, i) => {
			const light = (scene ? scene.lights : DEFAULT_LIGHTS)[i];
			if (!light) {
				slot.color.setScalar(0);
				return;
			}
			slot.color.copy(light.color);
			slot.direction.copy(light.direction);
		});
		// The scene's point lights are copied in per frame; off a backdrop there are none.
		if (!scene) for (const point of this.lighting.points) point.color.setScalar(0);
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

	/**
	 * Moves the backdrop's own point lights into view space, every frame: a torch flickers on a
	 * global sequence and a light rides whichever bone it hangs off. The model's directional lights
	 * are left out — they repeat the scene light set the glue screen supplies separately.
	 */
	private updateBackdropPointLights(): void {
		const backdrop = this.backdrop!;
		const { lights } = backdrop.model.m2;
		const slots = this.backdropLighting.points;
		let n = 0;
		for (let i = 0; i < lights.length && n < slots.length; i++) {
			if (lights[i].type !== M2LightType.Point) continue;
			const slot = slots[n++];
			slot.color.copy(backdrop.animator.lights[i].color);
			slot.position
				.copy(backdrop.animator.lights[i].position)
				.applyMatrix4(backdrop.matrixWorld)
				.applyMatrix4(this.backdropCamera.matrixWorldInverse);
		}
		for (; n < slots.length; n++) slots[n].color.setScalar(0);
		// The client gathers the scene's point lights for every model in it, the character included:
		// its glue callback resets the directional terms the scene light set replaces and leaves these
		// alone. So a moonwell or a brazier lights whoever stands by it.
		if (this.onBackdrop) {
			this.lighting.points.forEach((slot, i) => {
				slot.color.copy(slots[i].color);
				slot.position.copy(slots[i].position);
			});
		}
	}

	/**
	 * Stands each instance that has a backdrop attachment on that point of the scene, the character
	 * turned by `facing`. The client does the same by attaching the models to the backdrop and giving
	 * them a world transform of rotation and scale alone, so an instance's own position is dropped.
	 */
	private placeOnBackdrop(): void {
		const backdrop = this.backdrop!;
		tmpMatrix.copy(this.root.matrixWorld).invert().multiply(backdrop.matrixWorld);
		for (const [instance, attachmentId] of this.backdropAttachments) {
			if (instance.parent !== this.root) continue;
			const attachment = backdrop.attachmentMatrix(attachmentId, tmpAttachment);
			if (!attachment) continue;
			const facing = attachmentId === BACKDROP_CHARACTER_ATTACHMENT ? this.facing : 0;
			instance.matrix
				.multiplyMatrices(tmpMatrix, attachment)
				.multiply(tmpLocal.compose(ORIGIN, tmpQuat.setFromAxisAngle(tmpZ, facing), instance.scale));
			// The traversal that would carry this down has already run this frame.
			instance.updateMatrixWorld(true);
		}
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
		// An instance standing on a backdrop has its matrix written for it every frame, and this camera
		// only comes back into use once the backdrop is gone. So frame the place it goes then: its own
		// transform, which `updateMatrix` composes and the next frame overwrites again.
		for (const inst of this.instances) if (this.backdropAttachments.has(inst)) inst.updateMatrix();
		// `root`, not a scene: a fixed camera parents it under the backdrop's scene instead (see
		// `syncPlacement`), and the instances' world matrices hang off it either way.
		this.root.updateMatrixWorld(true);
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
		const fixed = this.onBackdrop;
		if (!fixed) {
			this.applyZoom();
			this.controls.update();
		}
		this.camera.updateMatrixWorld();
		if (!this.backdrop) {
			this.root.updateMatrixWorld(true);
			for (const inst of this.instances) inst.update(dtMs * this.timeScale, this.camera);
			return this.renderer.render(this.scene, this.camera);
		}
		// The backdrop first: the models stand on its attachment points, which its bones carry.
		this.backdropRoot.updateMatrixWorld(true);
		this.backdrop.update(dtMs * this.timeScale, this.backdropCamera);
		this.updateBackdropPointLights();
		const camera = fixed ? this.backdropCamera : this.camera;
		// Before `placeOnBackdrop`, which reads the root's world matrix and refreshes the instances it
		// moves; everything else takes its own from here.
		this.root.updateMatrixWorld(true);
		if (fixed) this.placeOnBackdrop();
		for (const inst of this.instances) inst.update(dtMs * this.timeScale, camera);
		// Fixed: the models stand in the backdrop's own scene, so one pass draws the lot and three.js
		// depth-tests and sorts them against its batches, as the client's single scene does. A
		// translucent batch writes no depth, so it can only cover what was drawn before it: in two
		// passes a banner in front of a character would always end up behind it.
		if (fixed) return this.renderer.render(this.backdropScene, this.backdropCamera);
		// Otherwise two passes with the depth buffer cleared between them: the backdrop keeps the
		// depths its own scene was built at, and the models always draw in front of all of it.
		this.renderer.autoClear = false;
		this.renderer.clear();
		this.renderer.render(this.backdropScene, this.backdropCamera);
		this.renderer.clearDepth();
		this.renderer.render(this.scene, camera);
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
		// dispose() leaves the context to the garbage collector, and browsers cap live contexts (16 in Chrome).
		this.renderer.forceContextLoss();
	}
}
