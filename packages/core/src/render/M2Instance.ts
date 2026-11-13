import { Bone, Camera, DetachedBindMode, Matrix4, Object3D, Skeleton, SkinnedMesh, Texture, Vector3 } from "three";
import type { AssetManager } from "../AssetManager.js";
import { M2Animator, type BillboardBasis } from "../animation/M2Animator.js";
import { M2BlendMode, M2TextureType, type M2Attachment } from "../formats/m2.js";
import { BowString } from "./BowString.js";
import { M2Material, TexCoordSource, type M2Lighting } from "./M2Material.js";
import type { M2Model } from "./M2Model.js";
import { ParticleSystem, type EmitterFrames } from "./ParticleSystem.js";
import { RibbonSystem } from "./RibbonSystem.js";

export interface PlayOptions {
	loop?: boolean;
	/** Variation index for animations with several sequences (default 0). */
	variation?: number;
}

interface AttachedChild {
	instance: M2Instance;
	attachment: M2Attachment;
}

const IDENTITY_BIND = new Matrix4();
const tmpMat = new Matrix4();
const tmpBasis: BillboardBasis = { right: new Vector3(), up: new Vector3(), back: new Vector3() };
const tmpSceneBasis: BillboardBasis = { right: new Vector3(), up: new Vector3(), back: new Vector3() };
/**
 * Down in the scene, which gravity follows for particles shed out of their emitter's frame.
 * `Viewer.root` turns WoW's Z-up into the scene's Y-up, so the scene's -Y is that direction.
 */
const SCENE_DOWN = new Vector3(0, -1, 0);
/** An emitter takes a ParticleColor.dbc set when its index is this, one past it, or two past it. */
const PARTICLE_COLOR_FIRST_INDEX = 11;
/**
 * Divides an emitter's priority plane down into a fraction of the step between one instance's render
 * order and the next, so that the plane orders emitters against each other without any of them
 * leaving their own instance's place in the scene. The client's widest plane either way is 100.
 */
const PLANE_STEP = 256;
// Right-handed like a camera basis (right x up = back), so quads are not mirrored without a camera.
const DEFAULT_BASIS: BillboardBasis = {
	right: new Vector3(0, 1, 0),
	up: new Vector3(0, 0, 1),
	back: new Vector3(1, 0, 0),
};
/** Rebuilt once per instance per frame; every emitter of that instance reads it within `update`. */
const tmpFrames: EmitterFrames = {
	local: DEFAULT_BASIS,
	scene: DEFAULT_BASIS,
	world: new Matrix4(),
	worldInverse: new Matrix4(),
	worldScale: 1,
	sceneDown: SCENE_DOWN,
};
const tmpVec = new Vector3();

/**
 * A renderable, animated instance of an M2Model. Add it to a three.js scene (it uses WoW's Z-up
 * coordinates, see `Viewer.root`), call `update()` every frame.
 */
export class M2Instance extends Object3D {
	readonly mesh: SkinnedMesh;
	readonly materials: M2Material[];
	readonly animator: M2Animator;
	/** Textures currently assigned per M2 texture index. */
	readonly textures: (Texture | null)[];
	readonly attached: AttachedChild[] = [];
	readonly particles: ParticleSystem[];
	readonly ribbons: RibbonSystem[];
	/** The string of a bow, once `showBowString()` has asked for it. */
	bowString: BowString | null = null;

	private readonly skeleton: Skeleton;
	/** Textures created for this instance alone; disposed with it. */
	private readonly ownedTextures = new Set<Texture>();
	private geosetFilter: (geosetId: number) => boolean = () => true;
	private playToken = 0;

	constructor(
		readonly model: M2Model,
		readonly assets: AssetManager,
		readonly lighting: M2Lighting,
	) {
		super();
		const { m2, skin } = model;
		this.animator = new M2Animator(model);
		this.textures = m2.textures.map(() => null);

		// Bones stay outside the scene graph; their world matrices are written directly.
		const bones = m2.bones.map(() => new Bone());
		this.skeleton = new Skeleton(
			bones,
			bones.map(() => new Matrix4()),
		);

		this.materials = skin.batches.map((b, bi) => {
			const mat = m2.materials[b.materialIndex];
			const shader = model.batchShaders[bi];
			return new M2Material(
				{
					blendMode: mat.blendMode,
					flags: mat.flags,
					texCoords: shader.texCoords,
					pixelShader: shader.pixelShader,
				},
				lighting,
				assets.whiteTexture,
			);
		});

		this.mesh = new SkinnedMesh(model.geometry, this.materials);
		this.mesh.bindMode = DetachedBindMode;
		this.mesh.bind(this.skeleton, IDENTITY_BIND);
		this.mesh.frustumCulled = false;
		this.add(this.mesh);

		this.particles = m2.particleEmitters.map(
			(e, i) => new ParticleSystem(e, assets.whiteTexture, lighting, undefined, i),
		);
		for (const ps of this.particles) this.add(ps.mesh);
		this.ribbons = m2.ribbonEmitters.map((r) => new RibbonSystem(r, [assets.whiteTexture], m2.materials, lighting));
		for (const rs of this.ribbons) this.add(...rs.meshes);
		this.setRenderOrder(0);
		this.applyTextures();
	}

	/** Creates an instance and loads its hardcoded textures. Replaceable slots stay white until set. */
	static async create(model: M2Model, assets: AssetManager, lighting: M2Lighting): Promise<M2Instance> {
		const inst = new M2Instance(model, assets, lighting);
		await Promise.all(
			model.m2.textures.map(async (t, i) => {
				if (t.type === M2TextureType.Hardcoded && t.filename) {
					inst.setTexture(i, await assets.loadTexture(t.filename, t.flags));
				}
			}),
		);
		await inst.playAnimation(0);
		return inst;
	}

	/** Assigns a texture to an M2 texture index. */
	setTexture(index: number, texture: Texture | null): void {
		this.textures[index] = texture;
		this.applyTextures();
	}

	/** Assigns a texture to every replaceable slot of the given type (see M2TextureType). */
	setReplaceableTexture(type: number, texture: Texture | null): void {
		this.model.m2.textures.forEach((t, i) => {
			if (t.type === type) this.textures[i] = texture;
		});
		this.applyTextures();
	}

	/**
	 * Recolours the emitters that ask for it. `colors` is a ParticleColor.dbc row's nine 0xAARRGGBB
	 * values (start, middle then end, three of each); each emitter's `particleColorIndex` picks one of
	 * the three sets. Emitters without an index keep their own colours, as does everything on null.
	 */
	setParticleColors(colors: ArrayLike<number> | null): void {
		for (const ps of this.particles) {
			const set = ps.emitter.particleColorIndex - PARTICLE_COLOR_FIRST_INDEX;
			if (!colors || set < 0 || set > 2) {
				ps.setColorOverride(null);
				continue;
			}
			const rgb = new Float32Array(9);
			for (let key = 0; key < 3; key++) {
				const c = colors[key * 3 + set];
				rgb[key * 3] = (c >>> 16) & 0xff;
				rgb[key * 3 + 1] = (c >>> 8) & 0xff;
				rgb[key * 3 + 2] = c & 0xff;
			}
			ps.setColorOverride(rgb);
		}
	}

	hasTextureType(type: number): boolean {
		return this.model.m2.textures.some((t) => t.type === type);
	}

	private applyTextures(): void {
		this.model.batchShaders.forEach((shader, bi) => {
			for (let i = 0; i < shader.textureCount; i++) {
				const ti = shader.textures[i];
				this.materials[bi].setTexture(i as 0 | 1, this.textures[ti] ?? this.assets.whiteTexture);
			}
		});
		for (const ps of this.particles) ps.setTexture(this.textures[ps.emitter.texture] ?? this.assets.whiteTexture);
		for (const rs of this.ribbons)
			rs.setTextures(
				Array.from(rs.ribbon.textures, (t) => this.textures[t] ?? null),
				this.assets.whiteTexture,
			);
	}

	/** Controls which geosets (submesh ids) are drawn. */
	setGeosetFilter(filter: (geosetId: number) => boolean): void {
		this.geosetFilter = filter;
		this.applyGeosets();
	}

	/** Shows exactly the given geoset ids. */
	showGeosets(ids: Iterable<number>): void {
		const set = new Set(ids);
		this.setGeosetFilter((id) => set.has(id));
	}

	private applyGeosets(): void {
		const { skin } = this.model;
		skin.batches.forEach((b, bi) => {
			this.materials[bi].visible = this.geosetFilter(skin.submeshes[b.submeshIndex].id);
		});
	}

	/** Geoset ids present in the model. */
	get geosetIds(): number[] {
		return [...new Set(this.model.skin.submeshes.map((s) => s.id))];
	}

	/** Plays an animation by id (AnimationData.dbc), loading its .anim data if needed. */
	async playAnimation(animId: number, opts: PlayOptions = {}): Promise<boolean> {
		const seq = this.model.findSequence(animId, opts.variation ?? 0);
		if (seq < 0) return false;
		await this.playSequence(seq, opts.loop);
		return true;
	}

	/** Plays a sequence by index, loading its .anim data if needed. */
	async playSequence(seq: number, loop = true): Promise<void> {
		const token = ++this.playToken;
		await this.assets.loadSequence(this.model, seq);
		if (token !== this.playToken) return; // superseded by a later call
		this.animator.play(seq, loop);
	}

	/** The model's attachment point with this id (see AttachmentId), or null when it has no usable one. */
	private attachment(attachmentId: number): M2Attachment | null {
		const { m2 } = this.model;
		const idx = m2.attachmentLookup[attachmentId];
		if (idx === undefined || idx < 0 || idx >= m2.attachments.length) return null;
		// An out-of-range bone would leave the render loop without a matrix to follow.
		return m2.attachments[idx].bone < m2.bones.length ? m2.attachments[idx] : null;
	}

	/** Attaches a child instance to an attachment point (see AttachmentId). Returns false if the model lacks it. */
	attachModel(child: M2Instance, attachmentId: number): boolean {
		const attachment = this.attachment(attachmentId);
		if (!attachment) return false;
		this.detachModel(child);
		child.matrixAutoUpdate = false;
		// Items draw before the body, so a helmet's translucent parts cannot paint over the face behind it.
		child.setRenderOrder(this.mesh.renderOrder - 1);
		this.attached.push({ instance: child, attachment });
		this.add(child);
		return true;
	}

	/**
	 * Draws the string of a bow between the `$WTT` and `$WTB` events its limbs carry, the way the
	 * client hangs `CDrawBowString` off a ranged weapon. Returns false, drawing nothing, for a model
	 * without that pair, which is most crossbows and nearly every gun. Carrying the pair says little
	 * in itself — weapon trails hang off the same two events, so most swords and axes have them too
	 * — so it is the caller that decides which items deserve a string.
	 */
	showBowString(): boolean {
		if (this.bowString) return true;
		const string = BowString.create(this.model.m2);
		if (!string) return false;
		this.bowString = string;
		string.line.renderOrder = this.mesh.renderOrder;
		string.update(this.animator.boneMatrices, this.lighting.ambient);
		this.add(string.line);
		return true;
	}

	/**
	 * Where an attachment point sits in this instance's own space, bone animation included. Null when
	 * the model has no such point (see AttachmentId).
	 */
	attachmentMatrix(attachmentId: number, out: Matrix4): Matrix4 | null {
		const attachment = this.attachment(attachmentId);
		if (!attachment) return null;
		const { bone, position } = attachment;
		return out
			.copy(this.animator.boneMatrices[bone])
			.multiply(tmpMat.makeTranslation(position[0], position[1], position[2]));
	}

	/**
	 * Seats this instance's meshes at `base`, its emitters nudged off it by their priority plane. The
	 * client sorts an emitter against the model's geometry by that plane; here the body is a single
	 * object, so the plane orders emitters among themselves and against the body as a whole.
	 *
	 * Attached items follow a step below, and their own visual effects a step below that, so a model
	 * and everything on it spans `base - 2 .. base`; anything meant to draw behind the lot of them
	 * needs a base below that.
	 */
	setRenderOrder(base: number): void {
		this.mesh.renderOrder = base;
		if (this.bowString) this.bowString.line.renderOrder = base;
		for (const { instance } of this.attached) instance.setRenderOrder(base - 1);
		for (const ps of this.particles) {
			// Only the emitters the client sorts by plane take one. The two blend modes it sends to the
			// opaque pass instead are sorted there by their material, depth deciding the picture, so they
			// keep the front-to-back order three.js gives them.
			const plane = ps.emitter.blendMode > M2BlendMode.AlphaKey ? ps.emitter.priorityPlane : 0;
			ps.mesh.renderOrder = base + plane / PLANE_STEP;
		}
		for (const rs of this.ribbons) {
			for (const mesh of rs.meshes) mesh.renderOrder = base + rs.ribbon.priorityPlane / PLANE_STEP;
		}
	}

	detachModel(child: M2Instance): void {
		const i = this.attached.findIndex((a) => a.instance === child);
		if (i < 0) return;
		this.attached.splice(i, 1);
		this.remove(child);
	}

	/** Back to time zero with no particles or trails, attached children too; the next `update` poses it. */
	rewind(): void {
		this.animator.rewind();
		for (const ps of this.particles) ps.reset();
		for (const rs of this.ribbons) rs.reset();
		for (const { instance } of this.attached) instance.rewind();
	}

	/** Advances animation and updates bones, materials and attached children. */
	update(dtMs: number, camera?: Camera): void {
		let basis: BillboardBasis | undefined;
		if (camera) {
			// Camera axes in this instance's local space.
			tmpMat.copy(this.matrixWorld).invert().multiply(camera.matrixWorld);
			const e = tmpMat.elements;
			tmpBasis.right.set(e[0], e[1], e[2]).normalize();
			tmpBasis.up.set(e[4], e[5], e[6]).normalize();
			tmpBasis.back.set(e[8], e[9], e[10]).normalize();
			basis = tmpBasis;
		}
		this.animator.update(dtMs, basis);

		const bones = this.skeleton.bones;
		for (let i = 0; i < bones.length; i++) bones[i].matrixWorld.copy(this.animator.boneMatrices[i]);

		this.updateMaterials();
		this.bowString?.update(this.animator.boneMatrices, this.lighting.ambient);

		const boneMatrices = this.animator.boneMatrices;
		if (this.particles.length > 0) {
			tmpFrames.local = basis ?? DEFAULT_BASIS;
			if (camera) {
				const c = camera.matrixWorld.elements;
				tmpSceneBasis.right.set(c[0], c[1], c[2]).normalize();
				tmpSceneBasis.up.set(c[4], c[5], c[6]).normalize();
				tmpSceneBasis.back.set(c[8], c[9], c[10]).normalize();
			}
			tmpFrames.scene = camera ? tmpSceneBasis : DEFAULT_BASIS;
			tmpFrames.world.copy(this.matrixWorld);
			tmpFrames.worldInverse.copy(this.matrixWorld).invert();
			// A creature display or a pet scales the whole instance; an emitter needs it to work out how
			// much of its own scale is reaching the sprites.
			tmpFrames.worldScale = tmpVec.setFromMatrixColumn(this.matrixWorld, 0).length();
			for (const ps of this.particles) {
				const bone = boneMatrices[ps.emitter.bone] ?? IDENTITY_BIND;
				ps.update(dtMs / 1000, this.animator, bone, tmpFrames);
			}
		}

		for (const rs of this.ribbons) {
			rs.update(dtMs / 1000, this.animator, boneMatrices[rs.ribbon.bone] ?? IDENTITY_BIND);
		}

		for (const { instance, attachment } of this.attached) {
			const [x, y, z] = attachment.position;
			instance.matrix.copy(this.animator.boneMatrices[attachment.bone]).multiply(tmpMat.makeTranslation(x, y, z));
			instance.matrixWorld.multiplyMatrices(this.matrixWorld, instance.matrix);
			instance.update(dtMs, camera);
		}
	}

	private updateMaterials(): void {
		const { m2, skin } = this.model;
		const anim = this.animator;
		skin.batches.forEach((b, bi) => {
			const mat = this.materials[bi];
			let r = 1,
				g = 1,
				bl = 1,
				a = 1;
			if (b.colorIndex >= 0 && b.colorIndex < m2.colors.length) {
				const o = b.colorIndex * 4;
				r = anim.colors[o];
				g = anim.colors[o + 1];
				bl = anim.colors[o + 2];
				a = anim.colors[o + 3];
			}
			const wi = m2.transparencyLookup[b.textureWeightComboIndex];
			if (wi !== undefined && wi >= 0 && wi < anim.textureWeights.length) a *= anim.textureWeights[wi];
			mat.setColor(r, g, bl, a);
			const shader = this.model.batchShaders[bi];
			for (let i = 0; i < shader.textureCount; i++) {
				const ti = shader.transforms[i];
				mat.setTextureMatrix(i as 0 | 1, ti >= 0 ? anim.textureMatrices[ti] : null);
			}
		});
	}

	/**
	 * Takes ownership of a texture this instance created itself (e.g. a composited character skin), so
	 * `dispose()` frees it. Textures from `AssetManager` are shared and must not be passed here.
	 */
	ownTexture(texture: Texture): void {
		this.ownedTextures.add(texture);
	}

	/** Releases GPU resources owned by this instance (not the shared model or cached textures). */
	dispose(): void {
		for (const m of this.materials) m.dispose();
		for (const ps of this.particles) ps.dispose();
		for (const rs of this.ribbons) rs.dispose();
		this.bowString?.dispose();
		this.bowString = null;
		for (const t of this.ownedTextures) t.dispose();
		this.ownedTextures.clear();
		this.skeleton.dispose();
		for (const { instance } of this.attached) instance.dispose();
		this.attached.length = 0; // a second dispose() must not re-dispose the children
	}
}
