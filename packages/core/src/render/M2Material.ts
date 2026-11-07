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
	/** Sphere-mapped from the camera-space reflection vector. */
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
/**
 * How many point lights a material shades with. Three is the most any backdrop has, and four covers
 * all but one of the 119 models in the client that carry lights at all.
 */
export const M2_MAX_POINT_LIGHTS = 4;

/** One directional light. */
export interface M2DirectionalLight {
	/** Unit vector towards the light, view space. */
	direction: Vector3;
	/** Diffuse colour, already scaled by the light's intensity; black is off. */
	color: Vector3;
}

/** One point light, falling off with distance. */
export interface M2PointLight {
	/** View space. */
	position: Vector3;
	/** Diffuse colour, already scaled by the light's intensity; black is off. */
	color: Vector3;
}

/**
 * Scene lighting shared by all M2 materials: an ambient term plus up to `M2_MAX_LIGHTS` directional
 * and `M2_MAX_POINT_LIGHTS` point lights. A material keeps the vectors themselves, so editing one in
 * place reaches every material at once; growing an array afterwards does not.
 */
export interface M2Lighting {
	ambient: Vector3;
	lights: M2DirectionalLight[];
	points: M2PointLight[];
	/**
	 * Linear fog: `x`, `y`, `z` are its colour and `w` the distance at which it has taken over
	 * completely, 0 leaving the scene clear. Packed into one vector so that a material binds it once
	 * and still sees later edits, as it does the light vectors.
	 */
	fog: Vector4;
}

/** Zero vector standing in for a light a `M2Lighting` does not have. Never written to. */
const NO_LIGHT = new Vector3();

/** Sizes the light arrays of `LIGHTING_GLSL`; a shader using it needs these defines. */
export const LIGHTING_DEFINES = {
	MAX_LIGHTS: String(M2_MAX_LIGHTS),
	MAX_POINT_LIGHTS: String(M2_MAX_POINT_LIGHTS),
} as const;

/**
 * The scene lighting a shader multiplies its colour by, as `m2Light(normal, viewPos)` over view-space
 * arguments. Called per vertex, as the client lights everything: its result is a vertex colour, which
 * the hardware clamps to 0..1 before interpolating it, so `m2Light` clamps too. Both matter next to a
 * light standing close by — one scene hangs a dim fill light inside the character's chest, which
 * unclamped and read per pixel burns a spotlight into the torso instead of lighting the whole body.
 */
export const LIGHTING_GLSL = /* glsl */ `
uniform vec3 uAmbient;
uniform vec3 uLightColor[MAX_LIGHTS];
uniform vec3 uLightDir[MAX_LIGHTS];
uniform vec3 uPointColor[MAX_POINT_LIGHTS];
uniform vec3 uPointPos[MAX_POINT_LIGHTS];

vec3 m2Light(vec3 n, vec3 viewPos) {
  vec3 light = uAmbient;
  for (int i = 0; i < MAX_LIGHTS; i++) light += uLightColor[i] * max(dot(n, uLightDir[i]), 0.0);
  for (int i = 0; i < MAX_POINT_LIGHTS; i++) {
    vec3 toLight = uPointPos[i] - viewPos;
    float dist = max(length(toLight), 0.001);
    // The falloff the glue screens use: no constant term, 0.7 linear and 0.03 quadratic.
    float atten = 1.0 / (0.7 * dist + 0.03 * dist * dist);
    light += uPointColor[i] * atten * max(dot(n, toLight / dist), 0.0);
  }
  return min(light, vec3(1.0));
}
`;

/** The uniforms `LIGHTING_GLSL` reads, bound to the `M2Lighting`'s own vectors. */
export function lightingUniforms(lighting: M2Lighting): Record<string, { value: Vector3 | Vector3[] }> {
	// A uniform array is a fixed size, so pad the missing lights out with black ones.
	const pick = (n: number, f: (i: number) => Vector3 | undefined) =>
		Array.from({ length: n }, (_, i) => f(i) ?? NO_LIGHT);
	return {
		uAmbient: { value: lighting.ambient },
		uLightColor: { value: pick(M2_MAX_LIGHTS, (i) => lighting.lights[i]?.color) },
		uLightDir: { value: pick(M2_MAX_LIGHTS, (i) => lighting.lights[i]?.direction) },
		uPointColor: { value: pick(M2_MAX_POINT_LIGHTS, (i) => lighting.points[i]?.color) },
		uPointPos: { value: pick(M2_MAX_POINT_LIGHTS, (i) => lighting.points[i]?.position) },
	};
}

/**
 * `s_fogModes`, one entry per blend mode: which colour a batch fogs towards. 1 is the scene's own,
 * and the rest are the colours their blend ops do nothing with.
 */
const FOG_MODES = [1, 1, 1, 2, 2, 3, 4];

/** The entry a batch or emitter takes from `s_fogModes`; zero where it asked not to be fogged. */
export function fogModeFor(blendMode: number, unfogged: boolean): number {
	return unfogged ? 0 : (FOG_MODES[blendMode] ?? 1);
}

/**
 * The fog a shader mixes towards, as `m2Fog(rgb, viewZ)`. Shared with the particle shader, which the
 * client fogs from the same table.
 */
export const FOG_GLSL = /* glsl */ `
uniform int uFogMode;
uniform vec4 uFog;

vec3 m2Fog(vec3 rgb, float viewZ) {
  if (uFogMode == 0 || uFog.w <= 0.0) return rgb;
  // Each mode fogs towards the colour its own blend treats as nothing, so a distant batch fades out
  // of the picture rather than washing towards the sky: black adds nothing, white modulates nothing,
  // and half grey is the one Mod2x doubles back to 1.
  vec3 fogColor = uFogMode == 1 ? uFog.xyz : uFogMode == 2 ? vec3(0.0) : uFogMode == 3 ? vec3(1.0) : vec3(128.0 / 255.0);
  return mix(rgb, fogColor, clamp(-viewZ / uFog.w, 0.0, 1.0));
}
`;

/** The uniforms `FOG_GLSL` reads: the scene's own fog vector, and which entry this draw takes. */
export function fogUniforms(lighting: M2Lighting, mode: number): Record<string, { value: Vector4 | number }> {
	return { uFog: { value: lighting.fog }, uFogMode: { value: mode } };
}

const VERTEX = /* glsl */ `
#include <common>
#include <skinning_pars_vertex>
${LIGHTING_GLSL}
uniform mat4 uTexMat0;
uniform mat4 uTexMat1;
uniform int uTexCoord0;
uniform int uTexCoord1;
varying vec2 vUv0;
varying vec2 vUv1;
varying vec3 vViewPos;
// Both faces lit here, since a vertex does not know which way the triangle it lands on will face.
varying vec3 vLightFront;
varying vec3 vLightBack;

vec2 texCoord(int src, vec3 n) {
  // The client's GxTexGen_SphereMap feeds D3D the camera-space *reflection* vector, not the normal,
  // and halves and recentres it. Taking the normal alone holds the sample still across a flat
  // surface, which is what turns a weapon's sweeping specular streak into an even wash of grey.
  if (src == 2) {
    vec3 r = reflect(normalize(vViewPos), n);
    return vec2(r.x * 0.5 + 0.5, 0.5 - r.y * 0.5);
  }
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
  vViewPos = mvPosition.xyz;
  vec3 n = normalize(transformedNormal);
  vLightFront = m2Light(n, vViewPos);
  vLightBack = m2Light(-n, vViewPos);
  vUv0 = (uTexMat0 * vec4(texCoord(uTexCoord0, n), 0.0, 1.0)).xy;
  vUv1 = (uTexMat1 * vec4(texCoord(uTexCoord1, n), 0.0, 1.0)).xy;
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
${FOG_GLSL}
varying vec2 vUv0;
varying vec2 vUv1;
varying vec3 vViewPos;
varying vec3 vLightFront;
varying vec3 vLightBack;

void main() {
  // A batch whose own alpha has faded away never reaches the client's draw list at all. The alpha
  // test cannot stand in for that, an alpha-key ref falling with the alpha and an opaque one being
  // zero throughout, and neither mode looks at alpha when it blends: both would paint on regardless.
  if (uColor.a < 0.0001) discard;
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
  if (!uUnlit) rgb *= gl_FrontFacing ? vLightFront : vLightBack;
  rgb = m2Fog(rgb, vViewPos.z);
  gl_FragColor = vec4(rgb, a);
}
`;

/**
 * The alpha ref the client picks per blend mode in `SetupMaterial`, compared the same way round
 * there: a fragment survives on `alpha >= ref`. `alpha` is the batch's own, which alpha-key is
 * alone in taking into account.
 */
export function alphaTestFor(blendMode: number, alpha = 1): number {
	return blendMode === M2BlendMode.AlphaKey ? (224 / 255) * alpha : blendMode >= M2BlendMode.Alpha ? 1 / 255 : 0;
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
	/** Kept because the alpha ref is rebuilt from it whenever the batch's own alpha moves. */
	private readonly blendMode: number;

	constructor(opts: M2MaterialOptions, lighting: M2Lighting, white: Texture) {
		const { blendMode, flags } = opts;
		super({
			vertexShader: VERTEX,
			fragmentShader: FRAGMENT,
			// three.js only defines USE_UV1 for built-in map channels, so declare it here to get `uv1`.
			defines: { USE_UV1: "", ...LIGHTING_DEFINES },
			uniforms: {
				...lightingUniforms(lighting),
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
				// `s_localLighting` denies the two modulate modes the scene lighting whatever the material's
				// own bit says; `setColor` supplies the flat colour that goes with it.
				uUnlit: {
					value:
						(flags & M2MaterialFlags.Unlit) !== 0 ||
						blendMode === M2BlendMode.Mod ||
						blendMode === M2BlendMode.Mod2x,
				},
				...fogUniforms(lighting, fogModeFor(blendMode, (flags & M2MaterialFlags.Unfogged) !== 0)),
			},
		});
		this.blendMode = blendMode;
		// Through the setter, so a batch nothing has animated yet still starts on the colour its blend
		// mode calls for rather than plain white.
		this.setColor(1, 1, 1, 1);
		this.side = flags & M2MaterialFlags.TwoSided ? DoubleSide : FrontSide;
		this.depthTest = !(flags & M2MaterialFlags.DepthTestOff);
		this.depthWrite = !(flags & M2MaterialFlags.DepthWriteOff);
		applyM2BlendMode(this, blendMode);
	}

	setTexture(layer: 0 | 1, texture: Texture): void {
		this.uniforms[layer === 0 ? "uTex0" : "uTex1"].value = texture;
	}

	setColor(r: number, g: number, b: number, a: number): void {
		// A modulate batch takes none of the colour: `SetupLighting` zeroes its lit term and hands it a
		// flat emissive instead, 1 for Mod and a half for Mod2x, whose blend doubles the result back up.
		// Only the alpha survives, which is why the track is still read for it.
		if (this.blendMode === M2BlendMode.Mod) r = g = b = 1;
		else if (this.blendMode === M2BlendMode.Mod2x) r = g = b = 0.5;
		(this.uniforms.uColor.value as Vector4).set(r, g, b, a);
		// The alpha a fragment is tested on carries this same factor, so for an alpha-key batch the two
		// cancel and the cut stays on the texture alone: the silhouette holds however far the batch fades.
		this.uniforms.uAlphaTest.value = alphaTestFor(this.blendMode, a);
	}

	setTextureMatrix(layer: 0 | 1, m: Matrix4 | null): void {
		const u = this.uniforms[layer === 0 ? "uTexMat0" : "uTexMat1"].value as Matrix4;
		if (m) u.copy(m);
		else u.identity();
	}
}
