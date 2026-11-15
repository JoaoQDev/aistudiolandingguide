import * as THREE from 'three';

/**
 * onBeforeCompile patch turning a MeshStandardMaterial into the regolith ground:
 * - multi-scale world-space detail (slopes + cavity + albedo) from one tileable texture,
 *   each scale rotated/offset so no tiling is visible, faded with distance;
 * - a lunar-like diffuse response (bright flats under a grazing sun, crisp terminator on
 *   micro-relief) replacing Lambert for direct light;
 * - a forward-scatter sheen around the Sun's direction that washes the ground towards white
 *   when looking sunward (only for the light aligned with uSunDirW, respecting shadows);
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
  uFill: { value: number };
  uShadeTint: { value: THREE.Color };
  uAmbientGain: { value: number };
}

const f = (v: number) => (Number.isInteger(v) ? `${v}.0` : `${v}`);

function buildDetailGLSL(scales: RegolithScale[]): string {
  const lines: string[] = [];
  lines.push('vec2 lunarSlope = vec2(0.0);');
  lines.push('float lunarAlb = 1.0;');
  lines.push('float lunarCav = 1.0;');
  lines.push('{');
  lines.push('  vec2 xz = vLunarWorld.xz;');
  lines.push('  float dist = length(vLunarWorld - cameraPosition);');
  for (const s of scales) {
    const c = Math.cos(s.angle);
    const sn = Math.sin(s.angle);
    lines.push(`  {`);
    lines.push(`    mat2 R = mat2(${f(c)}, ${f(sn)}, ${f(-sn)}, ${f(c)});`);
    lines.push(`    vec2 uv = R * (xz * ${f(1 / s.tile)}) + vec2(${f(s.offset[0])}, ${f(s.offset[1])});`);
    lines.push(`    vec4 t = texture2D(uDetail, uv);`);
    const fade = s.fade ? `(1.0 - smoothstep(${f(s.fade[0])}, ${f(s.fade[1])}, dist))` : '1.0';
    lines.push(`    float w = ${fade};`);
    lines.push(`    vec2 g = (t.rg * 255.0 - 128.0) / 64.0;`);
    lines.push(`    lunarSlope += (w * ${f(s.slope)}) * (transpose(R) * g);`);
    lines.push(`    lunarAlb *= 1.0 + (w * ${f(s.albedo * 2)}) * (t.a - 0.5);`);
    lines.push(`    lunarCav *= 1.0 - (w * ${f(s.cavity)}) * (1.0 - t.b);`);
    lines.push(`  }`);
  }
  lines.push('}');
  return lines.join('\n');
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
uniform float uFill;
uniform vec3 uShadeTint;
uniform float uAmbientGain;
varying vec3 vLunarWorld;
varying vec3 vLunarNormalW;
float lunarOcc = 1.0;
`;

    const direct = /* glsl */ `
#undef RE_Direct
#define RE_Direct RE_Direct_Lunar
void RE_Direct_Lunar( const in IncidentLight directLight, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in PhysicalMaterial material, inout ReflectedLight reflectedLight ) {
  float mu0 = dot( geometryNormal, directLight.direction );
  float lit = smoothstep( -0.03, 0.07, mu0 );
  float m = max( mu0, 0.0 );
  // Compressed response: grazing-lit flats stay bright, slopes facing away go black.
  float F = 2.0 * m / ( m + uPhotK );
  vec3 sunV = normalize( mat3( viewMatrix ) * uSunDirW );
  float isSun = smoothstep( 0.9, 0.98, dot( directLight.direction, sunV ) );
  vec3 ray = -geometryViewDir;
  vec3 upV = normalize( viewMatrix[ 1 ].xyz );
  // Forward-scatter lobe around the Sun direction.
  float c = max( dot( ray, sunV ), 0.0 );
  float c2 = c * c;
  float c4 = c2 * c2;
  float c8 = c4 * c4;
  float sinDep = max( -dot( ray, upV ), 0.0 );
  float graze = 1.0 - sinDep;
  float lobe = uSheenLobe * c8 * mix( 0.45, 1.0, graze * graze );
  // Glare column below the Sun (rough-surface glints elongated toward the viewer).
  vec3 rayH = ray + upV * sinDep;
  vec3 sunH = sunV - upV * dot( sunV, upV );
  float cAz = max( dot( normalize( rayH + 1e-6 ), normalize( sunH + 1e-6 ) ), 0.0 );
  // Narrow near the horizon, wider (and dimmer) toward the feet.
  float kAz = mix( 11.0, 4.5, clamp( sinDep / 0.55, 0.0, 1.0 ) );
  float column = uSheenColumn * pow( cAz, kAz ) * exp( -sinDep * 1.8 );
  float sheen = isSun * ( lobe + column ) * lit;
  float fill = isSun * uFill * ( 1.0 - lit );
  reflectedLight.directDiffuse += directLight.color * material.diffuseColor *
    ( ( RECIPROCAL_PI * uDiffuseGain * F * lit + RECIPROCAL_PI * fill ) * lunarOcc + RECIPROCAL_PI * sheen * mix( 1.0, lunarOcc, 0.5 ) );
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
          '#include <normal_fragment_begin>',
        ].join('\n'),
      )
      .replace(
        '#include <normal_fragment_maps>',
        [
          '#include <normal_fragment_maps>',
          '{',
          '  vec3 nW = normalize( normalize( vLunarNormalW ) - vec3( lunarSlope.x, 0.0, lunarSlope.y ) );',
          '  normal = normalize( ( viewMatrix * vec4( nW, 0.0 ) ).xyz );',
          '}',
        ].join('\n'),
      )
      .replace(
        '#include <lights_fragment_end>',
        '#include <lights_fragment_end>\nreflectedLight.indirectDiffuse *= uShadeTint * ( uAmbientGain * lunarOcc );',
      );
  };
}
