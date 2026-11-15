import * as THREE from 'three';

/**
 * onBeforeCompile patch turning a MeshStandardMaterial into the regolith ground:
 * - multi-scale world-space detail (slopes + cavity + albedo) from one tileable texture,
 *   each scale rotated/offset so no tiling is visible, faded with distance; the fine scales are
 *   damped at mid distance so the ground does not shimmer or streak while walking;
 * - a lunar-like diffuse response (bright flats under a grazing sun, soft terminator on
 *   micro-relief, lifted shade) replacing Lambert for direct light;
 * - a forward-scatter sheen around the Sun's direction that washes the ground towards white
 *   when looking sunward: a broad halo near the horizon plus a narrow glare wedge that stays
 *   bright down to the feet (only for the light aligned with uSunDirW, respecting shadows);
 * - weakened, distance-faded received shadows (the ground itself casts none, so these are prop
 *   shadows: the reference shows contact darkening rather than long dark shadow shapes);
 * - a faint lavender tint in shade.
 * The look is illustrative; it is not a calibrated photometric model.
 */

export interface RegolithScale {
  /** Tile size in metres. */
  tile: number;
  /** Rotation (radians) and offset of the tile. */
  angle: number;
  offset: [number, number];
  /** Slope contribution. */
  slope: number;
  /** Cavity (occlusion) contribution. */
  cavity: number;
  /** Albedo variation contribution. */
  albedo: number;
  /** Distance (m) over which the scale fades out: [start, end]; null = never. */
  fade: [number, number] | null;
  /** Optional slope damping with distance: [start, end, remaining factor]. */
  damp?: [number, number, number];
  /** Optional fade-in (m) of the cavity/albedo terms, so coarse pits do not blot the ground at the feet. */
  tintFadeIn?: [number, number];
}

export interface RegolithShaderOptions {
  scales: RegolithScale[];
}

export interface RegolithUniforms {
  uDetail: { value: THREE.Texture };
  uSunDirW: { value: THREE.Vector3 };
  uDiffuseGain: { value: number };
  uPhotK: { value: number };
  uSheenLobe: { value: number };
  uSheenColumn: { value: number };
  /** Exponential fall-off of the glare wedge with view depression (sin). */
  uSheenFall: { value: number };
  /** Azimuthal sharpness of the glare wedge at the horizon / at the feet. */
  uSheenSharp: { value: THREE.Vector2 };
  uFill: { value: number };
  uShadeTint: { value: THREE.Color };
  uAmbientGain: { value: number };
  /** Lowest occlusion the cavity term may reach. */
  uCavityFloor: { value: number };
  /** Received-shadow strength near the camera, and the factor left at/after uShadowFade.y metres. */
  uShadowStrength: { value: number };
  uShadowFade: { value: THREE.Vector3 };
}

const f = (v: number) => (Number.isInteger(v) ? `${v}.0` : `${v}`);

export function buildDetailGLSL(scales: RegolithScale[]): string {
  const lines: string[] = [];
  lines.push('vec2 lunarSlope = vec2(0.0);');
  lines.push('float lunarAlb = 1.0;');
  lines.push('float lunarCav = 1.0;');
  lines.push('float lunarDist = length(vLunarWorld - cameraPosition);');
  lines.push('{');
  lines.push('  vec2 xz = vLunarWorld.xz;');
  lines.push('  float dist = lunarDist;');
  for (const s of scales) {
    const c = Math.cos(s.angle);
    const sn = Math.sin(s.angle);
    lines.push(`  {`);
    lines.push(`    mat2 R = mat2(${f(c)}, ${f(sn)}, ${f(-sn)}, ${f(c)});`);
    lines.push(`    vec2 uv = R * (xz * ${f(1 / s.tile)}) + vec2(${f(s.offset[0])}, ${f(s.offset[1])});`);
    lines.push(`    vec4 t = texture2D(uDetail, uv);`);
    const fade = s.fade ? `(1.0 - smoothstep(${f(s.fade[0])}, ${f(s.fade[1])}, dist))` : '1.0';
    lines.push(`    float w = ${fade};`);
    const damp = s.damp ? `mix(1.0, ${f(s.damp[2])}, smoothstep(${f(s.damp[0])}, ${f(s.damp[1])}, dist))` : '1.0';
    lines.push(`    vec2 g = (t.rg * 255.0 - 128.0) / 64.0;`);
    lines.push(`    lunarSlope += (w * ${f(s.slope)} * ${damp}) * (transpose(R) * g);`);
    const tint = s.tintFadeIn ? `w * smoothstep(${f(s.tintFadeIn[0])}, ${f(s.tintFadeIn[1])}, dist)` : 'w';
    lines.push(`    float wt = ${tint};`);
    lines.push(`    lunarAlb *= 1.0 + (wt * ${f(s.albedo * 2)}) * (t.a - 0.5);`);
    lines.push(`    lunarCav *= 1.0 - (wt * ${f(s.cavity)}) * (1.0 - t.b);`);
    lines.push(`  }`);
  }
  lines.push('}');
  return lines.join('\n');
}

/** lights_fragment_begin with the directional shadow intensity scaled by `lunarShadowK`. */
export function patchedLightsBegin(chunk: string): string {
  const token = 'directionalLightShadow.shadowIntensity';
  if (!chunk.includes(token)) return '#include <lights_fragment_begin>';
  return chunk.split(token).join(`( ${token} * lunarShadowK )`);
}

export function applyRegolithShader(
  material: THREE.MeshStandardMaterial,
  uniforms: RegolithUniforms,
  opts: RegolithShaderOptions,
  cacheKey: string,
): void {
  material.customProgramCacheKey = () => cacheKey;
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);

    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        '#include <common>\nvarying vec3 vLunarWorld;\nvarying vec3 vLunarNormalW;',
      )
      .replace(
        '#include <project_vertex>',
        [
          '#include <project_vertex>',
          'vLunarWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;',
          'vLunarNormalW = normalize(mat3(modelMatrix) * objectNormal);',
        ].join('\n'),
      );

    const header = /* glsl */ `
uniform sampler2D uDetail;
uniform vec3 uSunDirW;
uniform float uDiffuseGain;
uniform float uPhotK;
uniform float uSheenLobe;
uniform float uSheenColumn;
uniform float uSheenFall;
uniform vec2 uSheenSharp;
uniform float uFill;
uniform vec3 uShadeTint;
uniform float uAmbientGain;
uniform float uCavityFloor;
uniform float uShadowStrength;
uniform vec3 uShadowFade;
varying vec3 vLunarWorld;
varying vec3 vLunarNormalW;
float lunarOcc = 1.0;
float lunarShadowK = 1.0;
float lunarMacroLit = 1.0;
vec3 lunarGeoNormalV = vec3( 0.0, 1.0, 0.0 );
`;

    const direct = /* glsl */ `
#undef RE_Direct
#define RE_Direct RE_Direct_Lunar
void RE_Direct_Lunar( const in IncidentLight directLight, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in PhysicalMaterial material, inout ReflectedLight reflectedLight ) {
  float mu0 = dot( geometryNormal, directLight.direction );
  float lit = smoothstep( -0.05, 0.1, mu0 );
  // Large-scale self-shadowing (geometry facing away from the Sun) stays black, as in the
  // reference; only the micro-relief from the detail maps gets the lifted shade.
  float macroLit = smoothstep( -0.06, 0.06, dot( lunarGeoNormalV, directLight.direction ) );
  lit *= macroLit;
  float m = max( mu0, 0.0 );
  // Compressed response: grazing-lit flats stay bright, slopes facing away fall into shade.
  float F = 2.0 * m / ( m + uPhotK );
  vec3 sunV = normalize( mat3( viewMatrix ) * uSunDirW );
  float isSun = smoothstep( 0.9, 0.98, dot( directLight.direction, sunV ) );
  vec3 ray = -geometryViewDir;
  vec3 upV = normalize( viewMatrix[ 1 ].xyz );
  // Broad forward-scatter halo around the Sun direction (strongest near the horizon).
  float c = max( dot( ray, sunV ), 0.0 );
  float c2 = c * c;
  float c4 = c2 * c2;
  float c8 = c4 * c4;
  float sinDep = max( -dot( ray, upV ), 0.0 );
  float graze = 1.0 - sinDep;
  float lobe = uSheenLobe * c8 * mix( 0.45, 1.0, graze * graze );
  // Glare wedge below the Sun (rough-surface glints elongated toward the viewer): narrow in
  // azimuth at every depression so views away from the Sun keep their crisp mid grey.
  vec3 rayH = ray + upV * sinDep;
  vec3 sunH = sunV - upV * dot( sunV, upV );
  float cAz = max( dot( normalize( rayH + 1e-6 ), normalize( sunH + 1e-6 ) ), 0.0 );
  float kAz = mix( uSheenSharp.x, uSheenSharp.y, clamp( sinDep / 0.55, 0.0, 1.0 ) );
  float column = uSheenColumn * pow( cAz, kAz ) * exp( -sinDep * uSheenFall );
  float sheen = isSun * ( lobe + column ) * lit;
  float fill = isSun * uFill * ( macroLit - lit );
  float occ = max( lunarOcc, uCavityFloor );
  reflectedLight.directDiffuse += directLight.color * material.diffuseColor *
    ( RECIPROCAL_PI * uDiffuseGain * F * lit * occ + RECIPROCAL_PI * fill * mix( 1.0, occ, 0.5 ) + RECIPROCAL_PI * sheen * mix( 1.0, occ, 0.5 ) );
}
`;

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${header}`)
      .replace('#include <lights_physical_pars_fragment>', `#include <lights_physical_pars_fragment>\n${direct}`)
      .replace(
        '#include <normal_fragment_begin>',
        [
          buildDetailGLSL(opts.scales),
          'diffuseColor.rgb *= lunarAlb;',
          'lunarOcc = lunarCav;',
          'lunarShadowK = uShadowStrength * mix( 1.0, uShadowFade.z, smoothstep( uShadowFade.x, uShadowFade.y, lunarDist ) );',
          '#include <normal_fragment_begin>',
        ].join('\n'),
      )
      .replace(
        '#include <normal_fragment_maps>',
        [
          '#include <normal_fragment_maps>',
          '{',
          '  lunarGeoNormalV = normalize( ( viewMatrix * vec4( normalize( vLunarNormalW ), 0.0 ) ).xyz );',
          '  lunarMacroLit = smoothstep( -0.06, 0.06, dot( normalize( vLunarNormalW ), normalize( uSunDirW ) ) );',
          '  vec3 nW = normalize( normalize( vLunarNormalW ) - vec3( lunarSlope.x, 0.0, lunarSlope.y ) );',
          '  normal = normalize( ( viewMatrix * vec4( nW, 0.0 ) ).xyz );',
          '}',
        ].join('\n'),
      )
      .replace('#include <lights_fragment_begin>', patchedLightsBegin(THREE.ShaderChunk.lights_fragment_begin))
      .replace(
        '#include <lights_fragment_end>',
        '#include <lights_fragment_end>\nreflectedLight.indirectDiffuse *= uShadeTint * ( uAmbientGain * max( lunarOcc, uCavityFloor ) * mix( 0.12, 1.0, lunarMacroLit ) );',
      );
  };
}
