// GLSL for the 3D view. The picture is lifted into 3D with its depth map: one Gaussian splat per
// 2x2 pixel patch, placed on the camera ray at its depth (Flash3D-style lifting), plus a sparse
// layer behind depth edges that fills what a moving camera uncovers.
//
// Rendering is surface splatting (Zwicker et al. 2001), so no sorting is needed: a visibility pass
// writes the nearest surface's depth, an accumulation pass blends every splat within a small depth
// tolerance of it with Gaussian weights, and a normalisation pass divides by the summed weight.
//
// Splat colours are not stored: each splat samples the relit 2D composite at its own pixel, every
// frame, so every light change shows up in 3D at once. View-dependent highlights from the brightest
// lights (with normals from the depth map) and glow sprites placed at the lights' 3D positions make
// the light itself sit in space: it slides over surfaces and hides behind things as you move.

const CAMERA = /* glsl */ `
uniform vec2 uImg;        // image size (px)
uniform float uFocal;     // focal length (px)
uniform vec2 uZ;          // inverse depth range: x = 1/zFar, y = 1/zNear
uniform mat4 uView;       // original camera -> moved camera
uniform float uStride;    // pixels per splat
uniform float uZoom;      // slight zoom while moved (keeps the edges covered)
vec3 lift(vec2 px, float d) {
  float z = 1.0 / mix(uZ.x, uZ.y, d);
  return vec3((px - 0.5 * uImg) / uFocal * z, z);
}
vec4 toClip(vec3 p) {
  // project onto the image plane of the moved camera; clip space covers the image
  vec2 s = p.xy / p.z * uFocal * uZoom + 0.5 * uImg;
  // textures here are in image space (row 0 = top) and stored bottom-up, so image top is ndc -1
  vec2 ndc = vec2(s.x / uImg.x * 2.0 - 1.0, s.y / uImg.y * 2.0 - 1.0);
  float zn = clamp((p.z - 0.05) / 400.0, 0.0, 1.0);
  return vec4(ndc, zn * 2.0 - 1.0, 1.0);
}
`;

export const SPLAT_VERT = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
layout(location = 0) in vec4 aPoint;   // pixel x, y, depth (0 far..1 near), layer (0 surface, 1 behind)
layout(location = 1) in vec3 aNormal;  // surface normal in the original camera space
layout(location = 2) in vec2 aSrc;     // where to take the colour from (pixel)
uniform sampler2D uColor;               // relit composite (linear)
uniform sampler2D uLight;               // light-only composite (linear)
uniform int uPass;                      // 0 visibility, 1 accumulation
uniform float uSize;                    // splat size multiplier (1 = its share of the picture)
uniform vec3 uEye;                      // moved camera position in original camera space
uniform int uLights;
uniform vec4 uLPos[8];                  // light positions (xyz) and reach (w), original camera space
uniform vec3 uLCol[8];                  // light colour x level
uniform float uSpec;                    // highlight strength
${CAMERA}
out vec3 vColor;
out vec3 vLight;
out float vLayer;
void main() {
  vec3 p = lift(aPoint.xy, aPoint.z);
  vec3 q = (uView * vec4(p, 1.0)).xyz;
  // accumulation pass: pull splats a little towards the camera so those just behind the visible
  // surface still blend in (the tolerance of surface splatting)
  if (uPass == 1) q *= (1.0 - 0.012 - 0.03 * aPoint.w);
  gl_Position = toClip(q);
  // footprint of one splat (its share of the picture) in pixels of the moved view
  float r = uStride * uSize * uZoom * (p.z / max(q.z, 0.05)) * (aPoint.w > 0.5 ? 1.7 : 1.0);
  // visibility discs must close every gap between neighbours (diagonals too), or what is
  // behind shows through; the blending kernel reaches a little further still
  gl_PointSize = clamp(r * (uPass == 0 ? 1.5 : 2.6), 1.0, 96.0);
  vLayer = aPoint.w;
  if (uPass == 0) { vColor = vec3(0.0); vLight = vec3(0.0); return; }
  vec2 uv = (aSrc + 0.5) / uImg;
  vec3 col = textureLod(uColor, uv, 0.0).rgb;
  vec3 lit = textureLod(uLight, uv, 0.0).rgb;
  // view-dependent sheen: the brightest lights glint on surfaces facing them, and the glint moves
  // as the camera moves
  vec3 n = normalize(aNormal);
  vec3 v = normalize(uEye - p);
  vec3 spec = vec3(0.0);
  for (int i = 0; i < 8; i++) {
    if (i >= uLights) break;
    vec3 l = uLPos[i].xyz - p;
    float dist = length(l);
    l /= dist;
    vec3 h = normalize(l + v);
    float fall = 1.0 / (1.0 + pow(dist / uLPos[i].w, 2.0));
    float s = pow(max(dot(n, h), 0.0), 48.0) * max(dot(n, l), 0.0);
    spec += uLCol[i] * s * fall;
  }
  // soft-limited so a noisy normal cannot throw a hard white speck
  spec = uSpec * spec / (1.0 + spec) * (1.0 - aPoint.w);
  vColor = col + spec;
  vLight = lit + spec;
}`;

export const SPLAT_FRAG = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
in vec3 vColor;
in vec3 vLight;
in float vLayer;
uniform int uPass;
layout(location = 0) out vec4 oColor;
layout(location = 1) out vec4 oLight;
void main() {
  vec2 c = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(c, c);
  if (uPass == 0) {
    // visibility: a solid disc
    if (r2 > 1.0) discard;
    oColor = vec4(0.0); oLight = vec4(0.0);
    return;
  }
  if (r2 > 1.0) discard;
  float w = exp(-r2 * 5.0) * (vLayer > 0.5 ? 0.35 : 1.0);
  oColor = vec4(vColor * w, w);
  oLight = vec4(vLight * w, w);
}`;

/** Divides by the summed weight; holes take the backdrop (the picture blurred) so nothing goes black. */
export const NORMALIZE = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv;
layout(location = 0) out vec4 oColor;
layout(location = 1) out vec4 oLight;
uniform sampler2D uAccC;
uniform sampler2D uAccL;
uniform sampler2D uBack;
void main() {
  // pull-push: where the splats are spread thin (a surface seen at a grazing angle, a gap the
  // camera opened), take the average of a larger neighbourhood from a coarser mip level
  vec4 c = vec4(0.0), l = vec4(0.0);
  float need = 0.35;
  for (int lod = 0; lod < 7; lod++) {
    vec4 cc = textureLod(uAccC, vUv, float(lod));
    vec4 ll = textureLod(uAccL, vUv, float(lod));
    // blend in the coarser level only as much as the finer one is missing
    float t = clamp(1.0 - c.a / need, 0.0, 1.0);
    c += cc * t; l += ll * t;
    if (c.a >= need) break;
    need *= 0.5;
  }
  vec3 back = texture(uBack, vUv).rgb * 0.85;
  float k = smoothstep(0.0, 0.01, c.a);
  oColor = vec4(mix(back, c.rgb / max(c.a, 1e-5), k), 1.0);
  oLight = vec4(mix(vec3(0.0), l.rgb / max(l.a, 1e-5), k), 1.0);
}`;

/** Glow sprites at the lights' 3D positions, depth-tested against the surfaces (hidden behind things). */
export const SPRITE_VERT = /* glsl */ `#version 300 es
precision highp float;
layout(location = 0) in vec4 aLight;   // pixel x, y, depth, size (px at the original view)
layout(location = 1) in vec3 aCol;     // colour x level
uniform float uGlow3d;
${CAMERA}
out vec3 vCol;
void main() {
  vec3 p = lift(aLight.xy, aLight.z);
  vec3 q = (uView * vec4(p, 1.0)).xyz;
  q *= 0.985; // sit just in front of its own surface
  gl_Position = toClip(q);
  gl_PointSize = clamp(aLight.w * uZoom * (p.z / max(q.z, 0.05)), 2.0, 128.0);
  vCol = aCol * uGlow3d;
}`;

export const SPRITE_FRAG = /* glsl */ `#version 300 es
precision highp float;
in vec3 vCol;
layout(location = 0) out vec4 oColor;
layout(location = 1) out vec4 oLight;
void main() {
  vec2 c = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(c, c);
  if (r2 > 1.0) discard;
  float g = exp(-r2 * 5.0) * 0.6 + exp(-r2 * 40.0) * 0.6;
  oColor = vec4(vCol * g, 0.0);
  oLight = vec4(vCol * g, 0.0);
}`;
