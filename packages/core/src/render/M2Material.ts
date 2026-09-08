import {
	type BlendingDstFactor,
	type BlendingSrcFactor,
	AddEquation,
	CustomBlending,
	DoubleSide,
	DstColorFactor,
	FrontSide,
	type Material,
	Matrix4,
	NoBlending,
	OneFactor,
	OneMinusSrcAlphaFactor,
	ShaderMaterial,
	SrcAlphaFactor,
	SrcColorFactor,
	Texture,
	Vector3,
	Vector4,
	ZeroFactor,
} from "three";
import { M2BlendMode, M2MaterialFlags } from "../formats/m2.js";

/** Where a texture layer takes its UVs from. */
export const enum TexCoordSource {
	Uv0 = 0,
	Uv1 = 1,
	/** Sphere-mapped from the view-space normal. */
	Env = 2,
}

export interface M2MaterialOptions {
	blendMode: number;
	flags: number;
	textureCount: number;
	texCoords: [TexCoordSource, TexCoordSource];
}

/** Scene lighting shared by all M2 materials. */
export interface M2Lighting {
	ambient: Vector3;
	diffuse: Vector3;
	/** Direction towards the light, view space. */
	direction: Vector3;
}

const VERTEX = /* glsl */ `
#include <common>
#include <skinning_pars_vertex>
uniform mat4 uTexMat0;
uniform mat4 uTexMat1;
uniform int uTexCoord0;
uniform int uTexCoord1;
varying vec2 vUv0;
varying vec2 vUv1;
varying vec3 vNormal;

vec2 texCoord(int src, vec3 n) {
  if (src == 2) return vec2(n.x * 0.5 + 0.5, 0.5 - n.y * 0.5);
#ifdef USE_UV1
  if (src == 1) return uv1;
#endif
  return uv;
}

void main() {
  #include <skinbase_vertex>
  #include <beginnormal_vertex>
  #include <skinnormal_vertex>
  #include <defaultnormal_vertex>
  #include <begin_vertex>
  #include <skinning_vertex>
  #include <project_vertex>
  vNormal = normalize(transformedNormal);
  vUv0 = (uTexMat0 * vec4(texCoord(uTexCoord0, vNormal), 0.0, 1.0)).xy;
  vUv1 = (uTexMat1 * vec4(texCoord(uTexCoord1, vNormal), 0.0, 1.0)).xy;
}
`;

const FRAGMENT = /* glsl */ `
uniform sampler2D uTex0;
uniform sampler2D uTex1;
uniform vec4 uColor;
uniform int uTexCount;
uniform float uAlphaTest;
uniform bool uOpaque;
uniform bool uUnlit;
uniform vec3 uAmbient;
uniform vec3 uDiffuse;
uniform vec3 uLightDir;
varying vec2 vUv0;
varying vec2 vUv1;
varying vec3 vNormal;

void main() {
  vec4 t0 = texture2D(uTex0, vUv0);
  vec3 rgb = t0.rgb * uColor.rgb;
  float a = (uOpaque ? 1.0 : t0.a) * uColor.a;
  if (uTexCount > 1) {
    vec4 t1 = texture2D(uTex1, vUv1);
    rgb *= t1.rgb;
    a *= t1.a;
  }
  if (a < uAlphaTest) discard;
  if (!uUnlit) {
    vec3 n = normalize(gl_FrontFacing ? vNormal : -vNormal);
    rgb *= uAmbient + uDiffuse * max(dot(n, uLightDir), 0.0);
  }
  gl_FragColor = vec4(rgb, a);
}
`;

/** Alpha test threshold used by the client for a blend mode. */
export function alphaTestFor(blendMode: number): number {
	return blendMode === M2BlendMode.AlphaKey ? 0.5 : blendMode >= M2BlendMode.Alpha ? 1 / 255 : 0;
}

/** Configures three.js blending (and `transparent`) for an M2 blend mode. */
export function applyM2BlendMode(mat: Material, mode: number): void {
	const set = (src: BlendingSrcFactor, dst: BlendingDstFactor) => {
		mat.blending = CustomBlending;
		mat.blendEquation = AddEquation;
		mat.blendSrc = src;
		mat.blendDst = dst;
		mat.blendSrcAlpha = OneFactor;
		mat.blendDstAlpha = OneMinusSrcAlphaFactor;
	};
	mat.transparent = mode >= M2BlendMode.Alpha;
	switch (mode) {
		case M2BlendMode.Opaque:
		case M2BlendMode.AlphaKey:
			mat.blending = NoBlending;
			return;
		case M2BlendMode.Alpha:
			return set(SrcAlphaFactor, OneMinusSrcAlphaFactor);
		case M2BlendMode.NoAlphaAdd:
			return set(OneFactor, OneFactor);
		case M2BlendMode.Add:
			return set(SrcAlphaFactor, OneFactor);
		case M2BlendMode.Mod:
			return set(DstColorFactor, ZeroFactor);
		case M2BlendMode.Mod2x:
			return set(DstColorFactor, SrcColorFactor);
		default:
			return set(OneFactor, OneMinusSrcAlphaFactor);
	}
}

/** Material for one M2 render batch. Lighting is done in gamma space like the original client. */
export class M2Material extends ShaderMaterial {
	readonly blendMode: number;
	readonly m2Flags: number;

	constructor(opts: M2MaterialOptions, lighting: M2Lighting, white: Texture) {
		const { blendMode, flags } = opts;
		super({
			vertexShader: VERTEX,
			fragmentShader: FRAGMENT,
			// three.js only defines USE_UV1 for built-in map channels, so declare it here to get `uv1`.
			defines: { USE_UV1: "" },
			uniforms: {
				uTex0: { value: white },
				uTex1: { value: white },
				uTexMat0: { value: new Matrix4() },
				uTexMat1: { value: new Matrix4() },
				uTexCoord0: { value: opts.texCoords[0] },
				uTexCoord1: { value: opts.texCoords[1] },
				uTexCount: { value: opts.textureCount },
				uColor: { value: new Vector4(1, 1, 1, 1) },
				uAlphaTest: { value: alphaTestFor(blendMode) },
				uOpaque: { value: blendMode === M2BlendMode.Opaque },
				uUnlit: { value: (flags & M2MaterialFlags.Unlit) !== 0 },
				uAmbient: { value: lighting.ambient },
				uDiffuse: { value: lighting.diffuse },
				uLightDir: { value: lighting.direction },
			},
		});
		this.blendMode = blendMode;
		this.m2Flags = flags;
		this.side = flags & M2MaterialFlags.TwoSided ? DoubleSide : FrontSide;
		this.depthTest = !(flags & M2MaterialFlags.DepthTestOff);
		this.depthWrite = !(flags & M2MaterialFlags.DepthWriteOff);
		applyM2BlendMode(this, blendMode);
	}

	setTexture(layer: 0 | 1, texture: Texture): void {
		this.uniforms[layer === 0 ? "uTex0" : "uTex1"].value = texture;
	}

	setColor(r: number, g: number, b: number, a: number): void {
		(this.uniforms.uColor.value as Vector4).set(r, g, b, a);
	}

	setTextureMatrix(layer: 0 | 1, m: Matrix4 | null): void {
		const u = this.uniforms[layer === 0 ? "uTexMat0" : "uTexMat1"].value as Matrix4;
		if (m) u.copy(m);
		else u.identity();
	}
}
