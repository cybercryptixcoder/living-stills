// GLSL for the compositor. All textures are in "image space": v = 0 is the top row.

export const VERT = /* glsl */ `#version 300 es
precision highp float;
out vec2 vUv;
void main() {
  vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  vUv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

/** Lights-off base + every light's contribution scaled by its gain, plus the moving sprite. */
export const COMPOSITE = /* glsl */ `#version 300 es
precision highp float;
precision highp sampler2DArray;
in vec2 vUv;
layout(location = 0) out vec4 oColor;
layout(location = 1) out vec4 oLight;

uniform sampler2DArray uBase;
uniform sampler2DArray uDelta;
uniform sampler2DArray uIds;
uniform sampler2DArray uW;
uniform sampler2D uTable;
uniform vec2 uSize;
uniform int uLayerA;
uniform int uLayerB;
uniform float uMix;
uniform float uAmbient;

uniform int uHasSprite;
uniform sampler2D uSpLit;
uniform sampler2D uSpDark;
uniform sampler2D uSpill;
uniform vec4 uSpRect;
uniform vec4 uSpillRect;
uniform float uSpDx;
uniform float uSpT;
uniform vec3 uSpGain;

vec3 gainAt(ivec2 p, int layer) {
  vec4 ids = texelFetch(uIds, ivec3(p, layer), 0) * 255.0;
  vec4 w = texelFetch(uW, ivec3(p, layer), 0);
  vec3 g = w.x * texelFetch(uTable, ivec2(int(ids.x + 0.5), 0), 0).rgb;
  g += w.y * texelFetch(uTable, ivec2(int(ids.y + 0.5), 0), 0).rgb;
  g += w.z * texelFetch(uTable, ivec2(int(ids.z + 0.5), 0), 0).rgb;
  g += w.w * texelFetch(uTable, ivec2(int(ids.w + 0.5), 0), 0).rgb;
  return g;
}

// Ids are categorical, so interpolate the resulting gains rather than the ids.
vec3 gainSmooth(vec2 uv, int layer) {
  vec2 p = uv * uSize - 0.5;
  vec2 f = fract(p);
  ivec2 i0 = ivec2(floor(p));
  ivec2 mx = ivec2(uSize) - 1;
  vec3 a = gainAt(clamp(i0, ivec2(0), mx), layer);
  vec3 b = gainAt(clamp(i0 + ivec2(1, 0), ivec2(0), mx), layer);
  vec3 c = gainAt(clamp(i0 + ivec2(0, 1), ivec2(0), mx), layer);
  vec3 d = gainAt(clamp(i0 + ivec2(1, 1), ivec2(0), mx), layer);
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

void layerColor(int layer, out vec3 col, out vec3 light) {
  vec3 base = texture(uBase, vec3(vUv, float(layer))).rgb;
  vec3 D = texture(uDelta, vec3(vUv, float(layer))).rgb;
  light = D * gainSmooth(vUv, layer);
  col = uAmbient * base + light;
}

void main() {
  vec3 col, light;
  layerColor(uLayerA, col, light);
  if (uMix > 0.001) {
    vec3 col2, light2;
    layerColor(uLayerB, col2, light2);
    col = mix(col, col2, uMix);
    light = mix(light, light2, uMix);
  }
  if (uHasSprite == 1) {
    vec2 px = vUv * uSize;
    vec2 sp = (px - uSpRect.xy - vec2(uSpDx, 0.0)) / uSpRect.zw;
    if (sp.x >= 0.0 && sp.y >= 0.0 && sp.x < 1.0 && sp.y < 1.0) {
      vec4 lit = texture(uSpLit, sp);
      vec4 dark = texture(uSpDark, sp);
      vec3 own = (lit.rgb - dark.rgb) * uSpGain * uSpT;
      vec3 sc = uAmbient * dark.rgb + own;
      col = sc + (1.0 - lit.a) * col;
      light = max(own, 0.0) + (1.0 - lit.a) * light;
    }
    vec2 ss = (px - uSpillRect.xy - vec2(uSpDx, 0.0)) / uSpillRect.zw;
    if (ss.x >= 0.0 && ss.y >= 0.0 && ss.x < 1.0 && ss.y < 1.0) {
      vec3 s = texture(uSpill, ss).rgb * uSpGain * uSpT;
      col += s;
      light += s;
    }
  }
  oColor = vec4(col, 1.0);
  oLight = vec4(light, 1.0);
}`;

/** 13-tap downsample (Jimenez 2014), with a soft threshold on the first pass. */
export const DOWN = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 o;
uniform sampler2D uSrc;
uniform vec2 uTexel;
vec3 s(vec2 d) { return texture(uSrc, vUv + uTexel * d).rgb; }
void main() {
  vec3 a = s(vec2(-2, -2)), b = s(vec2(0, -2)), c = s(vec2(2, -2));
  vec3 d = s(vec2(-1, -1)), e = s(vec2(1, -1));
  vec3 f = s(vec2(-2, 0)), g = s(vec2(0, 0)), h = s(vec2(2, 0));
  vec3 i = s(vec2(-1, 1)), j = s(vec2(1, 1));
  vec3 k = s(vec2(-2, 2)), l = s(vec2(0, 2)), m = s(vec2(2, 2));
  vec3 r = (d + e + i + j) * 0.125;
  r += (a + b + g + f) * 0.03125;
  r += (b + c + h + g) * 0.03125;
  r += (f + g + l + k) * 0.03125;
  r += (g + h + m + l) * 0.03125;
  o = vec4(r, 1.0);
}`;

/** 9-tap tent upsample of the smaller level, plus this level weighted. */
export const UP = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 o;
uniform sampler2D uLow;
uniform sampler2D uHigh;
uniform vec2 uLowTexel;
uniform float uHighWeight;
uniform float uLowWeight;
void main() {
  vec2 t = uLowTexel;
  vec3 r = texture(uLow, vUv).rgb * 4.0;
  r += (texture(uLow, vUv + vec2(-t.x, 0)).rgb + texture(uLow, vUv + vec2(t.x, 0)).rgb +
        texture(uLow, vUv + vec2(0, -t.y)).rgb + texture(uLow, vUv + vec2(0, t.y)).rgb) * 2.0;
  r += texture(uLow, vUv + vec2(-t.x, -t.y)).rgb + texture(uLow, vUv + vec2(t.x, -t.y)).rgb +
       texture(uLow, vUv + vec2(-t.x, t.y)).rgb + texture(uLow, vUv + vec2(t.x, t.y)).rgb;
  o = vec4(r / 16.0 * uLowWeight + texture(uHigh, vUv).rgb * uHighWeight, 1.0);
}`;

/** Places the picture on the canvas, adds glow and the blurred backdrop, tone maps and encodes sRGB. */
export const FINAL = /* glsl */ `#version 300 es
precision highp float;
out vec4 o;
uniform sampler2D uScene;
uniform sampler2D uGlow;
uniform sampler2D uBack;
uniform vec2 uBackTexel;
uniform vec4 uRect;      // image rect in canvas px: x, y (from top), w, h
uniform vec2 uCanvas;
uniform float uExposure;
uniform float uGlowAmt;
uniform float uGrain;
uniform float uTime;
uniform float uRadius;
uniform float uBackdrop;
uniform vec3 uMat;       // the flat colour behind the print (paper); 0 keeps the blurred backdrop
uniform vec2 uCover;     // scale of the backdrop uv (cover fit)

float hash(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

vec3 shoulder(vec3 c) {
  float m = max(c.r, max(c.g, c.b));
  const float k = 0.86;
  if (m <= k) return c;
  float mm = k + (1.0 - k) * (1.0 - exp(-(m - k) / (1.0 - k)));
  return c * (mm / m);
}

vec3 toSrgb(vec3 c) {
  c = clamp(c, 0.0, 1.0);
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}

float roundedMask(vec2 p, vec2 size, float r) {
  vec2 q = abs(p - size * 0.5) - (size * 0.5 - vec2(r));
  float d = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
  return clamp(0.5 - d, 0.0, 1.0);
}

void main() {
  vec2 sp = vec2(gl_FragCoord.x, uCanvas.y - gl_FragCoord.y);
  vec2 local = sp - uRect.xy;
  vec2 uv = local / uRect.zw;
  float inside = roundedMask(local, uRect.zw, uRadius);

  // Backdrop: the living picture itself, blurred and dimmed, filling the letterbox.
  vec2 cuv = (sp / uCanvas - 0.5) / uCover + 0.5;
  vec3 back = vec3(0.0);
  for (int y = -1; y <= 1; y++)
    for (int x = -1; x <= 1; x++) back += texture(uBack, cuv + vec2(x, y) * uBackTexel * 1.5).rgb;
  back *= uBackdrop / 9.0;

  vec3 c = back;
  if (inside > 0.0) {
    vec3 img = texture(uScene, clamp(uv, 0.0, 1.0)).rgb;
    c = mix(back, img, inside);
  }
  // Glow continues a little past the frame so bright lights near the edge bleed out softly.
  vec2 cl = clamp(uv, 0.0, 1.0);
  float outside = length((uv - cl) * uRect.zw);
  vec3 glow = texture(uGlow, cl).rgb * exp(-outside / 10.0) * mix(0.5, 1.0, inside);
  c += glow * uGlowAmt;

  c *= uExposure;
  c = shoulder(c);
  vec3 s = toSrgb(c);
  // Vignette on the picture only, very gentle.
  vec2 vv = uv - 0.5;
  s *= mix(1.0, 1.0 - 0.22 * dot(vv, vv) * 1.6, inside);
  // Film grain, stronger in the shadows.
  float lum = dot(s, vec3(0.299, 0.587, 0.114));
  float n = hash(gl_FragCoord.xy + fract(uTime * 7.31) * 911.0) - 0.5;
  s += n * uGrain * (0.045 - 0.025 * lum);
  // The print sits on a flat mat (paper): everything outside the frame is that colour, not a backdrop.
  s = mix(uMat, s, inside);
  o = vec4(s, 1.0);
}`;
