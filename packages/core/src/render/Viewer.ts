import { Box3, Color, Group, LinearSRGBColorSpace, PerspectiveCamera, Scene, Vector3, WebGLRenderer } from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { M2Lighting } from "./M2Material";
import type { M2Instance } from "./M2Instance";

export interface ViewerOptions {
	/** Canvas to render into; created inside `container` when omitted. */
	canvas?: HTMLCanvasElement;
	container?: HTMLElement;
	/** Clear color; null for a transparent canvas. */
	background?: number | null;
	antialias?: boolean;
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
	readonly lighting: M2Lighting = {
		ambient: new Vector3(0.55, 0.55, 0.55),
		diffuse: new Vector3(0.7, 0.7, 0.7),
		direction: new Vector3(0.3, 0.6, 0.75).normalize(),
	};
	/** Animation speed multiplier; 0 pauses. */
	timeScale = 1;

	private raf = 0;
	private lastTime = 0;
	private readonly resizeObserver: ResizeObserver | null = null;

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
		if (opts.background !== null)
			this.scene.background = new Color().setHex(opts.background ?? 0x2a2d33, LinearSRGBColorSpace);

		this.camera = new PerspectiveCamera(45, 1, 0.05, 500);
		this.camera.position.set(4, 1.5, 0);
		this.controls = new OrbitControls(this.camera, canvas);
		this.controls.target.set(0, 1, 0);
		this.controls.enableDamping = true;

		this.root.rotation.x = -Math.PI / 2;
		this.scene.add(this.root);

		const host = canvas.parentElement ?? canvas;
		this.resizeObserver = new ResizeObserver(() => this.resize());
		this.resizeObserver.observe(host);
		this.resize();
	}

	get canvas(): HTMLCanvasElement {
		return this.renderer.domElement;
	}

	add(instance: M2Instance): void {
		this.instances.push(instance);
		this.root.add(instance);
	}

	remove(instance: M2Instance): void {
		const i = this.instances.indexOf(instance);
		if (i >= 0) this.instances.splice(i, 1);
		this.root.remove(instance);
	}

	clear(dispose = true): void {
		for (const inst of [...this.instances]) {
			this.remove(inst);
			if (dispose) inst.dispose();
		}
	}

	/** Points the camera at the instances' bounds (attached models included). */
	frame(padding = 1.3): void {
		if (this.instances.length === 0) return;
		this.scene.updateMatrixWorld(true);
		const box = new Box3();
		const addBounds = (inst: M2Instance) => {
			// Bind-pose geometry bounds; the M2 bounding box is often much looser.
			const g = inst.model.geometry;
			if (!g.boundingBox) g.computeBoundingBox();
			box.union(g.boundingBox!.clone().applyMatrix4(inst.matrixWorld));
			for (const a of inst.attached) addBounds(a.instance);
		};
		for (const inst of this.instances) addBounds(inst);
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
		this.controls.update();
	}

	resize(): void {
		const el = this.canvas.parentElement ?? this.canvas;
		const w = el.clientWidth || 1;
		const h = el.clientHeight || 1;
		this.renderer.setSize(w, h, false);
		this.camera.aspect = w / h;
		this.camera.updateProjectionMatrix();
	}

	/** Renders one frame, advancing animations by `dtMs`. */
	render(dtMs = 0): void {
		this.controls.update();
		this.camera.updateMatrixWorld();
		this.root.updateMatrixWorld(true);
		for (const inst of this.instances) inst.update(dtMs * this.timeScale, this.camera);
		this.renderer.render(this.scene, this.camera);
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
		this.clear();
		this.controls.dispose();
		this.renderer.dispose();
	}
}
