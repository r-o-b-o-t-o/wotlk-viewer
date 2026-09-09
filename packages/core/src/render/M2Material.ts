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
	/** How the second texture layer combines with the first (see M2Combiner). */
	combiner: number;
}

/** How many directional lights a material shades with; the glue backdrops use at most three. */
export const M2_MAX_LIGHTS = 3;

/** One directional light. */
export interface M2Light {
	/** Unit vector towards the light, view space. */
	direction: Vector3;
	/** Diffuse colour, already scaled by the light's intensity; black is off. */
	color: Vector3;
}

/**
 * Scene lighting shared by all M2 materials: an ambient term plus up to `M2_MAX_LIGHTS`
 * directional ones. A material keeps the vectors themselves, so editing one in place reaches every
 * material at once; growing the array afterwards does not.
 */
export interface M2Lighting {
	ambient: Vector3;
	lights: M2Light[];
	/**
	 * Linear fog: `x`, `y`, `z` are its colour and `w` the distance at which it has taken over
	 * completely, 0 leaving the scene clear. Packed into one vector so that a material binds it once
	 * and still sees later edits, as it does the light vectors.
	 */
	fog: Vector4;
}

/** Zero vector standing in for a light a `M2Lighting` does not have. Never written to. */
const NO_LIGHT = new Vector3();

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
varying float vViewDepth;

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
  vViewDepth = -mvPosition.z;
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
uniform int uCombiner;
uniform float uAlphaTest;
uniform bool uOpaque;
uniform bool uUnlit;
uniform bool uUnfogged;
uniform vec3 uAmbient;
uniform vec3 uLightColor[MAX_LIGHTS];
uniform vec3 uLightDir[MAX_LIGHTS];
uniform vec4 uFog;
varying vec2 vUv0;
varying vec2 vUv1;
varying vec3 vNormal;
varying float vViewDepth;

void main() {
  vec4 t0 = texture2D(uTex0, vUv0);
  vec3 rgb = t0.rgb * uColor.rgb;
  float a = (uOpaque ? 1.0 : t0.a) * uColor.a;
  if (uTexCount > 1) {
    // Layer one is always a modulate here; the second layer's op comes from the model (M2Combiner).
    // The "NA" variants differ only in leaving the alpha of the first layer alone.
    vec4 t1 = texture2D(uTex1, vUv1);
    if (uCombiner == 3 || uCombiner == 7) {   // Add, AddNA
      rgb += t1.rgb;
      if (uCombiner == 3) a += t1.a;
    } else if (uCombiner == 4 || uCombiner == 6) {  // Mod2x, Mod2xNA
      rgb *= t1.rgb * 2.0;
      if (uCombiner == 4) a *= t1.a * 2.0;
    } else {                                  // Mod, Opaque and anything not modelled
      rgb *= t1.rgb;
      if (uCombiner != 0) a *= t1.a;
    }
  }
  if (a < uAlphaTest) discard;
  if (!uUnlit) {
    vec3 n = normalize(gl_FrontFacing ? vNormal : -vNormal);
    vec3 light = uAmbient;
    for (int i = 0; i < MAX_LIGHTS; i++) light += uLightColor[i] * max(dot(n, uLightDir[i]), 0.0);
    rgb *= light;
  }
  if (!uUnfogged && uFog.w > 0.0) rgb = mix(rgb, uFog.xyz, clamp(vViewDepth / uFog.w, 0.0, 1.0));
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
	constructor(opts: M2MaterialOptions, lighting: M2Lighting, white: Texture) {
		const { blendMode, flags } = opts;
		// A uniform array is a fixed size, so pad the missing lights out with black ones.
		const lights = Array.from({ length: M2_MAX_LIGHTS }, (_, i) => ({
			direction: lighting.lights[i]?.direction ?? NO_LIGHT,
			color: lighting.lights[i]?.color ?? NO_LIGHT,
		}));
		super({
			vertexShader: VERTEX,
			fragmentShader: FRAGMENT,
			// three.js only defines USE_UV1 for built-in map channels, so declare it here to get `uv1`.
			defines: { USE_UV1: "", MAX_LIGHTS: String(M2_MAX_LIGHTS) },
			uniforms: {
				uTex0: { value: white },
				uTex1: { value: white },
				uTexMat0: { value: new Matrix4() },
				uTexMat1: { value: new Matrix4() },
				uTexCoord0: { value: opts.texCoords[0] },
				uTexCoord1: { value: opts.texCoords[1] },
				uTexCount: { value: opts.textureCount },
				uCombiner: { value: opts.combiner },
				uColor: { value: new Vector4(1, 1, 1, 1) },
				uAlphaTest: { value: alphaTestFor(blendMode) },
				uOpaque: { value: blendMode === M2BlendMode.Opaque },
				uUnlit: { value: (flags & M2MaterialFlags.Unlit) !== 0 },
				// Fog washes an additive or modulated batch out instead of dimming it, so only the
				// modes that paint over what is behind them take any.
				uUnfogged: { value: (flags & M2MaterialFlags.Unfogged) !== 0 || blendMode > M2BlendMode.Alpha },
				uFog: { value: lighting.fog },
				uAmbient: { value: lighting.ambient },
				uLightColor: { value: lights.map((l) => l.color) },
				uLightDir: { value: lights.map((l) => l.direction) },
			},
		});
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
