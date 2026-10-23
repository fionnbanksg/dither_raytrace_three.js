// Voxel raytracer: two-level DDA (coarse 8^3 bricks, then voxels) -> per-voxel AO + variation
// -> one shadow ray per light (jittered for soft shadows) -> fog -> Bayer dither.
// Rendered at a low internal resolution and upscaled with nearest-neighbour by CSS.

export const vert = /* glsl */`
void main() {
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

export const frag = /* glsl */`
uniform sampler3D uVoxels;
uniform sampler3D uCoarse;
uniform vec3  uSize;
uniform vec3  uCamPos;
uniform vec3  uCamFwd;
uniform vec3  uCamRight;
uniform vec3  uCamUp;
uniform vec2  uRes;
uniform float uTanHalf;
uniform float uTime;
uniform float uLevels;      // colour levels per channel after dithering
uniform float uAmbient;     // ambient light strength
uniform float uSoft;        // shadow jitter radius (voxels) -> soft shadows
uniform float uEmissive;    // brightness of emissive voxels (id >= 6)
uniform float uDither;      // dither strength: 0 = banding, 1 = full Bayer
uniform float uInvScale;    // 4 / voxelsPerTile: converts voxel distances to the old unit scale
uniform float uBlock;       // size (voxels) of the blocky colour-variation cells
uniform vec3  uPalette[8];
uniform vec3  uLightPos[8];
uniform vec3  uLightCol[8]; // colour * intensity
uniform int   uLightCount;

layout(location = 0) out highp vec4 fragColor;

const int BRICK         = 8;
const int MAX_COARSE    = 200;
const int SHADOW_COARSE = 100;
const int EMISSIVE_ID   = 6;

// ------------------------------------------------------------ helpers
int voxelAt(ivec3 p) {
  return int(texelFetch(uVoxels, p, 0).r * 255.0 + 0.5);
}
bool inBounds(ivec3 c) {
  return all(greaterThanEqual(c, ivec3(0))) && all(lessThan(c, ivec3(uSize)));
}
bool solidAt(ivec3 c) {
  return inBounds(c) && voxelAt(c) > 0;
}

float hash13(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.zyx + 31.32);
  return fract((p.x + p.y) * p.z);
}

// 8x8 Bayer matrix via bit tricks (0..1)
float bayer8(ivec2 p) {
  int x = p.x & 7, y = p.y & 7;
  int a = x ^ y;
  int v = ((a & 1) << 5) | ((y & 1) << 4) | ((a & 2) << 2) | ((y & 2) << 1) | ((a & 4) >> 1) | ((y & 4) >> 2);
  return (float(v) + 0.5) / 64.0;
}

vec3 safeDir(vec3 d) { return normalize(d + 1e-5); }

// ------------------------------------------------------------ tracing
struct Hit {
  bool  hit;
  int   id;
  ivec3 cell;
  float t;
  vec3  n;
};

Hit noHit() {
  Hit h;
  h.hit = false; h.id = 0; h.cell = ivec3(0); h.t = 1e9; h.n = vec3(0.0);
  return h;
}

// Two-level grid traversal. rd must be normalised.
// Outer loop walks 8^3 bricks; bricks that contain stone are walked voxel by voxel.
Hit trace(vec3 ro, vec3 rd, int maxCoarse, float maxT) {
  vec3  stp  = sign(rd);
  vec3  inv  = 1.0 / rd;
  vec3  dlt  = abs(inv);
  float B    = float(BRICK);
  ivec3 csz  = ivec3(uSize) / BRICK;

  ivec3 cc     = ivec3(floor(ro / B));
  vec3  cside  = (vec3(cc) * B + (stp * 0.5 + 0.5) * B - ro) * inv;  // t when leaving each brick axis
  vec3  cdelta = dlt * B;
  vec3  cmask  = vec3(0.0);
  float tEnter = 0.0;

  for (int i = 0; i < maxCoarse; i++) {
    if (any(lessThan(cc, ivec3(0))) || any(greaterThanEqual(cc, csz))) break;

    if (texelFetch(uCoarse, cc, 0).r > 0.0) {
      ivec3 lo   = cc * BRICK;
      vec3  p    = ro + rd * (tEnter + 1e-3);
      ivec3 cell = clamp(ivec3(floor(p)), lo, lo + (BRICK - 1));
      vec3  side = (stp * (vec3(cell) - ro + 0.5) + 0.5) * dlt;
      vec3  fmask = cmask;

      for (int j = 0; j < 3 * BRICK; j++) {
        int id = voxelAt(cell);
        if (id > 0) {
          Hit h;
          h.hit = true; h.id = id; h.cell = cell;
          h.t = dot(fmask, side - dlt);
          h.n = -fmask * stp;
          return h;
        }
        fmask = step(side, side.yzx) * step(side, side.zxy);
        side += fmask * dlt;
        cell += ivec3(fmask * stp);
        if (any(lessThan(cell, lo)) || any(greaterThanEqual(cell, lo + BRICK))) break;
      }
    }

    cmask  = step(cside, cside.yzx) * step(cside, cside.zxy);
    tEnter = dot(cmask, cside);
    cside += cmask * cdelta;
    cc    += ivec3(cmask * stp);
    if (tEnter > maxT) break;
  }
  return noHit();
}

bool occluded(vec3 ro, vec3 rd, float dist) {
  Hit h = trace(ro, rd, SHADOW_COARSE, dist);
  return h.hit && h.t < dist;
}

// ------------------------------------------------------------ surface
// Classic voxel vertex AO, bilinearly interpolated across the face.
float cornerAO(ivec3 a, ivec3 du, ivec3 dv) {
  bool s1 = solidAt(a + du), s2 = solidAt(a + dv), c = solidAt(a + du + dv);
  if (s1 && s2) return 0.0;
  return (3.0 - float(s1) - float(s2) - float(c)) / 3.0;
}

float faceAO(ivec3 cell, vec3 n, vec3 p) {
  ivec3 a = cell + ivec3(n);
  vec3 ua = (abs(n.x) > 0.5) ? vec3(0, 1, 0) : vec3(1, 0, 0);
  vec3 va = (abs(n.z) > 0.5) ? vec3(0, 1, 0) : vec3(0, 0, 1);
  vec3 loc = p - vec3(cell);
  float fu = clamp(dot(loc, ua), 0.0, 1.0);
  float fv = clamp(dot(loc, va), 0.0, 1.0);
  ivec3 U = ivec3(ua), V = ivec3(va);
  float a00 = cornerAO(a, -U, -V), a10 = cornerAO(a,  U, -V);
  float a01 = cornerAO(a, -U,  V), a11 = cornerAO(a,  U,  V);
  return 0.35 + 0.65 * mix(mix(a00, a10, fu), mix(a01, a11, fu), fv);
}

vec3 albedo(int id, ivec3 cell) {
  vec3 base = uPalette[id];
  base *= 0.88 + 0.24 * hash13(floor(vec3(cell) / uBlock) + float(id));   // chunky blocks
  base *= 0.95 + 0.10 * hash13(vec3(cell) + 7.0);                          // per-voxel grit
  return base;
}

vec3 sky(vec3 rd) {
  float star = step(0.9975, hash13(floor(rd * 160.0)));
  return vec3(0.008, 0.012, 0.03) + star * 0.7;
}

vec3 shade(Hit h, vec3 ro, vec3 rd) {
  vec3 p = ro + rd * h.t;

  if (h.id >= EMISSIVE_ID) {
    float fl = 0.85 + 0.3 * hash13(floor(vec3(h.cell) / uBlock) + floor(uTime * 8.0));
    return uPalette[h.id] * uEmissive * fl;
  }

  vec3  alb = albedo(h.id, h.cell);
  float ao  = faceAO(h.cell, h.n, p);
  vec3  lit = alb * vec3(0.6, 0.7, 1.0) * uAmbient * ao;

  vec3 sp = p + h.n * 0.02;                                  // shadow ray origin
  for (int i = 0; i < 8; i++) {
    if (i >= uLightCount) break;

    vec3  L = uLightPos[i] - sp;
    float d = length(L);
    L /= d;
    float ndl = max(dot(h.n, L), 0.0);
    if (ndl <= 0.0) continue;

    float du  = d * uInvScale;
    float att = 1.0 / (1.0 + 0.07 * du * du);
    vec3  contrib = uLightCol[i] * ndl * att;
    if (max(contrib.r, max(contrib.g, contrib.b)) < 0.004) continue;

    // jitter the light position per pixel; the dither hides the noise
    vec3 jit = vec3(
      hash13(vec3(gl_FragCoord.xy, 1.0 + float(i))),
      hash13(vec3(gl_FragCoord.xy, 7.0 + float(i))),
      hash13(vec3(gl_FragCoord.xy, 13.0 + float(i)))) - 0.5;
    vec3  target = uLightPos[i] + jit * uSoft;
    vec3  sd = target - sp;
    float sl = length(sd);
    if (occluded(sp, safeDir(sd), sl - 0.05)) continue;

    lit += alb * contrib * mix(1.0, ao, 0.6);
  }
  return lit;
}

// ------------------------------------------------------------ main
void main() {
  vec2 uv = (gl_FragCoord.xy / uRes) * 2.0 - 1.0;
  uv.x *= uRes.x / uRes.y;

  vec3 ro = uCamPos;
  vec3 rd = safeDir(uCamFwd + (uCamRight * uv.x + uCamUp * uv.y) * uTanHalf);

  Hit h = trace(ro, rd, MAX_COARSE, 1e5);
  vec3 col;
  if (h.hit) {
    col = shade(h, ro, rd);
    col *= exp(-h.t * uInvScale * 0.03);
  } else {
    col = sky(rd);
  }

  // tone + ordered dither
  col = pow(max(col, 0.0), vec3(0.6));
  float b = bayer8(ivec2(gl_FragCoord.xy));
  col = floor(col * (uLevels - 1.0) + 0.5 + (b - 0.5) * uDither) / (uLevels - 1.0);
  col = clamp(col, 0.0, 1.0);

  fragColor = vec4(col, 1.0);
}
`;