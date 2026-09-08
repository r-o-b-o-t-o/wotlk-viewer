import { Bone, Camera, DetachedBindMode, Matrix4, Object3D, Skeleton, SkinnedMesh, Texture, Vector3 } from "three";
import type { AssetManager } from "../AssetManager.js";
import { M2Animator, type BillboardBasis } from "../animation/M2Animator.js";
import { M2TextureType, type M2Attachment } from "../formats/m2.js";
import { M2Material, TexCoordSource, type M2Lighting } from "./M2Material.js";
import type { M2Model } from "./M2Model.js";
import { ParticleSystem } from "./ParticleSystem.js";

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
// Right-handed like a camera basis (right x up = back), so quads are not mirrored without a camera.
const DEFAULT_BASIS: BillboardBasis = {
	right: new Vector3(0, 1, 0),
	up: new Vector3(0, 0, 1),
	back: new Vector3(1, 0, 0),
};

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

		this.materials = skin.batches.map((b) => {
			const mat = m2.materials[b.materialIndex];
			const coords = [TexCoordSource.Uv0, TexCoordSource.Uv0] as [TexCoordSource, TexCoordSource];
			for (let i = 0; i < Math.min(b.textureCount, 2); i++) {
				const unit = m2.textureUnitLookup[b.textureCoordComboIndex + i];
				coords[i] = unit < 0 ? TexCoordSource.Env : unit === 1 ? TexCoordSource.Uv1 : TexCoordSource.Uv0;
			}
			return new M2Material(
				{
					blendMode: mat.blendMode,
					flags: mat.flags,
					textureCount: Math.min(b.textureCount, 2),
					texCoords: coords,
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

		this.particles = m2.particleEmitters.map((e) => new ParticleSystem(e, assets.whiteTexture));
		for (const ps of this.particles) this.add(ps.mesh);
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

	hasTextureType(type: number): boolean {
		return this.model.m2.textures.some((t) => t.type === type);
	}

	private applyTextures(): void {
		const { m2, skin } = this.model;
		skin.batches.forEach((b, bi) => {
			for (let i = 0; i < Math.min(b.textureCount, 2); i++) {
				const ti = m2.textureLookup[b.textureComboIndex + i];
				this.materials[bi].setTexture(i as 0 | 1, this.textures[ti] ?? this.assets.whiteTexture);
			}
		});
		for (const ps of this.particles) ps.setTexture(this.textures[ps.emitter.texture] ?? this.assets.whiteTexture);
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

	/** Attaches a child instance to an attachment point (see AttachmentId). Returns false if the model lacks it. */
	attachModel(child: M2Instance, attachmentId: number): boolean {
		const { m2 } = this.model;
		const idx = m2.attachmentLookup[attachmentId];
		if (idx === undefined || idx < 0 || idx >= m2.attachments.length) return false;
		// An out-of-range bone would leave the render loop without a matrix to follow.
		if (m2.attachments[idx].bone >= m2.bones.length) return false;
		this.detachModel(child);
		child.matrixAutoUpdate = false;
		// Items draw before the body, so a helmet's translucent parts cannot paint over the face behind it.
		child.mesh.renderOrder = this.mesh.renderOrder - 1;
		this.attached.push({ instance: child, attachment: m2.attachments[idx] });
		this.add(child);
		return true;
	}

	detachModel(child: M2Instance): void {
		const i = this.attached.findIndex((a) => a.instance === child);
		if (i < 0) return;
		this.attached.splice(i, 1);
		this.remove(child);
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

		const boneMatrices = this.animator.boneMatrices;
		for (const ps of this.particles) {
			const bone = boneMatrices[ps.emitter.bone] ?? IDENTITY_BIND;
			ps.update(dtMs / 1000, this.animator, bone, basis ?? DEFAULT_BASIS);
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
			for (let i = 0; i < Math.min(b.textureCount, 2); i++) {
				const ti = m2.textureTransformLookup[b.textureTransformComboIndex + i];
				mat.setTextureMatrix(i as 0 | 1, ti !== undefined && ti >= 0 ? anim.textureMatrices[ti] : null);
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
		for (const t of this.ownedTextures) t.dispose();
		this.ownedTextures.clear();
		this.skeleton.dispose();
		for (const { instance } of this.attached) instance.dispose();
		this.attached.length = 0; // a second dispose() must not re-dispose the children
	}
}
