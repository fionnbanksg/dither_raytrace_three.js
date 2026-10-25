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
uniform float uEmissive;    // brightness of emissive voxels (id == 6)
uniform float uDither;      // dither strength: 0 = banding, 1 = full Bayer
uniform float uInvScale;    // 4 / voxelsPerTile: converts voxel distances to the old unit scale
uniform float uBlock;       // size (voxels) of the blocky colour-variation cells
uniform vec3  uPalette[12];
uniform vec3  uLightPos[8];
uniform vec3  uLightCol[8]; // colour * intensity
uniform int   uLightCount;
uniform sampler2D uParticles;   // 3 texels x N rows, see particles.js
uniform int   uParticleCount;   // live voxel-cube particles
uniform vec3  uGunOff;          // viewmodel offset in camera space (recoil, bob, sway)
uniform float uMuzzle;          // muzzle flash 0..1
uniform float uGunType;         // 0 = grenade launcher, 1 = lava gun
uniform vec4  uPBound;          // bounding sphere of all particles (xyz, r): rays that miss it skip the loop
uniform sampler3D uGlow;        // light thrown by resting lava, R8, one texel = uGlowTexel voxels (see lavaglow.js)
uniform vec3  uGlowCol;         // glow colour * strength
uniform float uGlowScale;       // field value that byte 255 stands for
uniform float uGlowTexel;       // voxels per glow texel
uniform vec3  uSunDir;          // see sky.js
uniform vec3  uMoonDir;
uniform vec3  uCelLightDir;        // the one directional light that is on (sun by day, moon by night)
uniform vec3  uCelLightCol;     // its colour * intensity (0 at the horizon)
uniform vec3  uSkyAmb;          // ambient light from open sky
uniform vec3  uZenith;
uniform vec3  uHorizon;
uniform vec3  uDusk;            // warm glow around the sun at sunrise / sunset
uniform vec3  uSunDisc;
uniform float uNight;           // 0 day .. 1 night: star visibility
uniform vec2  uSkyRot;          // cos, sin of the star-field rotation
uniform sampler3D uSuper;       // third traversal level: 1 byte per 4x4x4 coarse bricks, 1 = contains stone
uniform sampler2D uLightTex;    // half-res light pass output (see LIGHT_PASS in main())
uniform vec2  uResLow;          // size of that texture
uniform float uAspect;          // full-res width / height

float gSky = 0.0;               // sky visibility of the last lit surface (0 indoors): drives distance fog colour

layout(location = 0) out highp vec4 fragColor;

const int BRICK         = 8;
const int MAX_COARSE    = 200;
const int SHADOW_COARSE = 64;    // was 100: shadow rays give up (= lit) after 64 brick steps
const int LAVA_PASSES   = 3;     // was 6: how many lava surfaces a shadow ray may step through
// Light budget (perf): lights dimmer than LIGHT_CUTOFF at this surface are skipped, and only the
// MAX_SHADOW_LIGHTS strongest lights per pixel get a shadow ray (the rest are dropped).
const float LIGHT_CUTOFF     = 0.015;   // was 0.004
const int   MAX_SHADOW_LIGHTS = 4;
// Indoors early-out: if the sky ray is blocked and the sun / moon is higher than this (its y component),
// assume a roof is in the way and skip the sun ray. Set to 2.0 to turn this off.
const float SUN_SKIP_Y = 0.75;
// Third traversal level (32^3-voxel blocks): rays hop over empty blocks. Set false if you ever see holes or see-through walls.
const bool USE_SUPER = true;
// Soft-shadow jitter is uSoft * SOFT_SCALE (1.0 = original softness). Smaller = harder shadows, more coherent rays.
const float SOFT_SCALE = 0.625;
const int EMISSIVE_ID   = 6;
const int LAVA_ID       = 8;

// ------------------------------------------------------------ helpers
int voxelAt(ivec3 p) {
  return int(texelFetch(uVoxels, p, 0).r * 255.0 + 0.5);
}
bool inBounds(ivec3 c) {
  return all(greaterThanEqual(c, ivec3(0))) && all(lessThan(c, ivec3(uSize)));
}
bool solidAt(ivec3 c) {
  if (!inBounds(c)) return false;
  int id = voxelAt(c);
  return id > 0 && id != 8;      // lava never occludes ambient (AO) or the never-aim-into-stone check
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
  // Rays that start above the volume (player flying/launched high) first travel down to its top face.
  float yOff = 0.0;
  if (ro.y >= uSize.y) {
    if (rd.y >= -1e-5) return noHit();
    yOff = (ro.y - uSize.y + 1e-3) / -rd.y;
    if (yOff >= maxT) return noHit();
    ro += rd * yOff;
    maxT -= yOff;
  }
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
  ivec3 sSize  = textureSize(uSuper, 0);
  float SB     = B * 4.0;                                            // voxels per third-level block edge

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
          h.t = dot(fmask, side - dlt) + yOff;
          h.n = -fmask * stp;
          return h;
        }
        fmask = step(side, side.yzx) * step(side, side.zxy);
        side += fmask * dlt;
        cell += ivec3(fmask * stp);
        if (any(lessThan(cell, lo)) || any(greaterThanEqual(cell, lo + BRICK))) break;
      }
    } else {
      // empty brick: if its whole 4x4x4-brick block is empty too, hop straight out of the block
      ivec3 sc = cc >> 2;
      if (USE_SUPER && all(lessThan(sc, sSize)) && texelFetch(uSuper, sc, 0).r <= 0.0) {
        vec3  sx   = (vec3(sc) * SB + (stp * 0.5 + 0.5) * SB - ro) * inv;   // t when leaving the block on each axis
        vec3  sm   = step(sx, sx.yzx) * step(sx, sx.zxy);
        float tOut = dot(sm, sx);
        ivec3 nc   = ivec3(floor((ro + rd * (tOut + 1e-3)) / B));
        if (any(notEqual(nc >> 2, sc))) {                          // really left the block (guards float edge cases)
          if (tOut > maxT) break;
          cc = nc; cmask = sm; tEnter = tOut;
          cside = (vec3(cc) * B + (stp * 0.5 + 0.5) * B - ro) * inv;
          continue;
        }
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

// Lava glows, it doesn't block light: shadow rays step through it (a few voxels at a time) and keep going.
bool occluded(vec3 ro, vec3 rd, float dist) {
  float t0 = 0.0;
  for (int k = 0; k < LAVA_PASSES; k++) {
    Hit h = trace(ro + rd * t0, rd, SHADOW_COARSE, dist - t0);
    if (!h.hit || h.t >= dist - t0) return false;
    if (h.id != LAVA_ID) return true;
    t0 += h.t + 1.0;
    if (t0 >= dist) return false;
  }
  return false;
}

// ------------------------------------------------------------ surface
// Classic voxel vertex AO, bilinearly interpolated across the face.
// The four corners share their side / diagonal neighbours, so the 3x3 neighbourhood is fetched once (8 cells, not 12).
float aoCorner(bool s1, bool s2, bool c) {
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
  bool sUp = solidAt(a + U),     sUm = solidAt(a - U);
  bool sVp = solidAt(a + V),     sVm = solidAt(a - V);
  bool cpp = solidAt(a + U + V), cmp = solidAt(a - U + V);
  bool cpm = solidAt(a + U - V), cmm = solidAt(a - U - V);
  float a00 = aoCorner(sUm, sVm, cmm), a10 = aoCorner(sUp, sVm, cpm);
  float a01 = aoCorner(sUm, sVp, cmp), a11 = aoCorner(sUp, sVp, cpp);
  return 0.35 + 0.65 * mix(mix(a00, a10, fu), mix(a01, a11, fu), fv);
}

vec3 albedo(int id, ivec3 cell) {
  vec3 base = uPalette[id];
  base *= 0.88 + 0.24 * hash13(floor(vec3(cell) / uBlock) + float(id));   // chunky blocks
  base *= 0.95 + 0.10 * hash13(vec3(cell) + 7.0);                          // per-voxel grit
  return base;
}

vec3 sky(vec3 rd) {
  float h = clamp(rd.y, 0.0, 1.0);
  vec3 c = mix(uHorizon, uZenith, pow(h, 0.55));

  float sd = dot(rd, uSunDir);
  c += uDusk * pow(max(sd, 0.0), 5.0) * (1.0 - h * 0.7);              // glow around the sun at dusk / dawn
  c += uSunDisc * (smoothstep(0.9992, 0.9996, sd) + 0.25 * pow(max(sd, 0.0), 220.0));

  float md = dot(rd, uMoonDir);
  c += vec3(0.85, 0.9, 1.0) * 1.4 * smoothstep(0.9993, 0.9996, md) * smoothstep(-0.05, 0.1, uMoonDir.y) * (0.35 + 0.65 * uNight);

  if (uNight > 0.01 && rd.y > -0.05) {
    vec3 r = vec3(uSkyRot.x * rd.x - uSkyRot.y * rd.y, uSkyRot.y * rd.x + uSkyRot.x * rd.y, rd.z);
    vec3 cell = floor(r * 160.0);
    float star = step(0.9975, hash13(cell));
    float tw = 0.65 + 0.35 * hash13(cell + floor(uTime * 1.5));
    c += star * tw * 0.8 * uNight * smoothstep(-0.05, 0.1, rd.y);
  }
  return c;
}

vec3 applyFog(vec3 c, float t) {
  return mix(uHorizon * 0.55 * gSky, c, exp(-t * uInvScale * 0.03));   // indoors gSky = 0: fades to black as before
}

float lavaNoise(vec3 p) {
  vec3 c = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = hash13(c),                  b = hash13(c + vec3(1, 0, 0));
  float cc = hash13(c + vec3(0, 1, 0)), d = hash13(c + vec3(1, 1, 0));
  float e = hash13(c + vec3(0, 0, 1)),  g = hash13(c + vec3(1, 0, 1));
  float h = hash13(c + vec3(0, 1, 1)),  i = hash13(c + vec3(1, 1, 1));
  return mix(mix(mix(a, b, f.x), mix(cc, d, f.x), f.y), mix(mix(e, g, f.x), mix(h, i, f.x), f.y), f.z);
}

// ------------------------------------------------------------ lava glow
// The glow field is built on the CPU from lava cells that are resting on something (lavaglow.js), spread through
// open air only, so a wall facing a puddle lights up and the room next door stays dark.
float glowAt(vec3 p) {
  return texture(uGlow, p / uSize).r * uGlowScale;
}

vec3 lavaGlow(vec3 p, vec3 n, vec3 alb, float ao) {
  vec3  q = p + n * (uGlowTexel * 0.5);                 // step off the surface so we read the air texel, not the stone
  float g = glowAt(q);
  if (g < 0.01) return vec3(0.0);

  // the field's gradient points at the brighter side = towards the lava: surfaces facing it get the full glow,
  // surfaces turned away still get a diffuse share (the light has soaked into the space around them)
  float e = uGlowTexel;
  vec3 grad = vec3(glowAt(q + vec3(e, 0, 0)) - glowAt(q - vec3(e, 0, 0)),
                   glowAt(q + vec3(0, e, 0)) - glowAt(q - vec3(0, e, 0)),
                   glowAt(q + vec3(0, 0, e)) - glowAt(q - vec3(0, 0, e)));
  float gl = length(grad);
  float facing = gl > 0.02 ? clamp(dot(n, grad / gl), 0.0, 1.0) : 0.5;
  float wrap = 0.35 + 0.65 * facing;

  float slow = 0.88 + 0.24 * lavaNoise(vec3(q.x * 0.04, q.z * 0.04, uTime * 0.3));   // the crust breathes, slowly
  return alb * uGlowCol * g * wrap * slow * mix(1.0, ao, 0.5);
}

// Unshadowed strength of light i at a surface (max channel), used to cull / rank lights before any ray is cast.
float lightLum(int i, vec3 sp, vec3 n) {
  vec3  L = uLightPos[i] - sp;
  float d = length(L);
  float ndl = max(dot(n, L / d), 0.0);
  float du  = d * uInvScale;
  vec3  c = uLightCol[i] * ndl / (1.0 + 0.07 * du * du);
  return max(c.r, max(c.g, c.b));
}

// The ray-casting half of the lighting, evaluated with albedo = 1 and no AO so it does not depend on the pixel's own
// material: sky visibility (vis, 0 or 1) plus the sun / moon and point-light terms (returned).
// The half-res light pass stores exactly this and neighbouring full-res pixels reuse it (see fetchLight).
vec3 castLights(vec3 p, vec3 n, out float vis) {
  vec3 E = vec3(0.0);
  vec3 sp = p + n * 0.3;                                    // shadow ray origin

  // open sky: ambient from above (only where the sky can be seen) + one sun / moon shadow ray
  vec3 sj = vec3(hash13(vec3(gl_FragCoord.xy, 41.0)), hash13(vec3(gl_FragCoord.xy, 43.0)), hash13(vec3(gl_FragCoord.xy, 47.0))) - 0.5;
  vis = occluded(sp, safeDir(vec3(0.0, 0.9, 0.0) + n * 0.5 + sj * 0.8), 700.0) ? 0.0 : 1.0;
  float sn = max(dot(n, uCelLightDir), 0.0);
  if (sn > 0.0 && max(uCelLightCol.r, max(uCelLightCol.g, uCelLightCol.b)) > 0.004 &&
      !(vis == 0.0 && uCelLightDir.y > SUN_SKIP_Y) &&
      !occluded(sp, safeDir(uCelLightDir + sj * 0.05), 900.0)) {
    E += uCelLightCol * sn;
  }

  // cheap pass first: how strong is each light here? (no rays)
  float lum[8];
  for (int i = 0; i < 8; i++) lum[i] = (i < uLightCount) ? lightLum(i, sp, n) : 0.0;

  for (int i = 0; i < 8; i++) {
    if (i >= uLightCount) break;
    if (lum[i] < LIGHT_CUTOFF) continue;
    int rank = 0;                                             // how many lights beat this one
    for (int j = 0; j < 8; j++) rank += int(lum[j] > lum[i] || (lum[j] == lum[i] && j < i));
    if (rank >= MAX_SHADOW_LIGHTS) continue;

    vec3  L = uLightPos[i] - sp;
    float d = length(L);
    L /= d;
    float ndl = max(dot(n, L), 0.0);
    float du  = d * uInvScale;
    float att = 1.0 / (1.0 + 0.07 * du * du);
    vec3  contrib = uLightCol[i] * ndl * att;

    // jitter the light position per pixel; the dither hides the noise
    vec3 jit = vec3(
      hash13(vec3(gl_FragCoord.xy, 1.0 + float(i))),
      hash13(vec3(gl_FragCoord.xy, 7.0 + float(i))),
      hash13(vec3(gl_FragCoord.xy, 13.0 + float(i)))) - 0.5;
    vec3  target = uLightPos[i] + jit * (i == 0 ? 0.0 : uSoft * SOFT_SCALE);   // torch: hard shadow, other lights stay soft
    if (solidAt(ivec3(floor(target)))) target = uLightPos[i];     // never aim a shadow ray into stone
    vec3  sd = target - sp;
    float sl = length(sd);
    if (occluded(sp, safeDir(sd), sl - 0.05)) continue;

    E += contrib;
  }
  return E;
}

// The material half: ambient + sky + (sun + lights) tinted by albedo and occlusion, plus the lava glow.
vec3 shadeLit(vec3 p, vec3 n, vec3 alb, float ao, vec3 E, float vis) {
  vec3 lit = alb * vec3(0.6, 0.7, 1.0) * uAmbient * ao;
  lit += alb * uSkyAmb * vis * (0.55 + 0.45 * n.y) * mix(1.0, ao, 0.7);
  lit += alb * E * mix(1.0, ao, 0.6);
  return lit + lavaGlow(p, n, alb, ao);
}

// Both halves at full resolution. Used for particle cubes and for pixels that cannot reuse the light pass.
vec3 lightSurface(vec3 p, vec3 n, vec3 alb, float ao) {
  float vis;
  vec3 E = castLights(p, n, vis);
  gSky = vis;
  return shadeLit(p, n, alb, ao, E, vis);
}

// 0..5 for the six axis-aligned face directions (compared as floats so it can be packed into the light texture)
float faceCode(vec3 n) {
  return n.x > 0.5 ? 0.0 : (n.x < -0.5 ? 1.0 : (n.y > 0.5 ? 2.0 : (n.y < -0.5 ? 3.0 : (n.z > 0.5 ? 4.0 : 5.0))));
}

#ifdef USE_LIGHT_BUFFER
// Reuse the half-res light pass: bilinear over the 4 nearest texels, counting only texels that saw the same face
// direction at a similar distance (so light never bleeds across an edge). Returns false when none qualify
// (silhouettes, thin geometry): the caller then casts its own rays.
bool fetchLight(float t, vec3 n, out vec3 E, out float vis) {
  vec2  S  = uRes / uResLow;
  vec2  f  = gl_FragCoord.xy / S - 0.5;
  vec2  f0 = floor(f);
  vec2  fr = f - f0;
  ivec2 i0 = ivec2(f0);
  ivec2 lim = ivec2(uResLow) - 1;
  float code = faceCode(n);
  float tol  = 2.0 + 0.08 * t;
  vec3  eSum = vec3(0.0);
  float vSum = 0.0, wSum = 0.0;
  for (int k = 0; k < 4; k++) {
    ivec2 o = ivec2(k & 1, k >> 1);
    float w = ((o.x == 1) ? fr.x : 1.0 - fr.x) * ((o.y == 1) ? fr.y : 1.0 - fr.y);
    vec4  d = texelFetch(uLightTex, clamp(i0 + o, ivec2(0), lim), 0);
    float kk = floor(d.a / 8192.0);
    float tk = d.a - kk * 8192.0;
    if (floor(kk * 0.5) != code || abs(tk - t) > tol) continue;
    eSum += d.rgb * w;
    vSum += mod(kk, 2.0) * w;
    wSum += w;
  }
  if (wSum < 1e-3) return false;
  E = eSum / wSum;
  vis = vSum / wSum;
  return true;
}
#endif

// Lava: emissive like the braziers, but with slow drifting hot/cool blotches (value noise in voxel blocks)
// so it reads as molten rock with a darker crust rather than a flat orange slab. Hot cells go yellow-white.
// All animation is smooth (time is a continuous noise axis, no stepped hashes), so nothing pops or flickers.
vec3 shadeLava(Hit h, vec3 p) {
  float s = uBlock * 3.0;                                              // blotch size in voxels
  vec3  q = vec3(p.x, p.z, uTime * 0.12 * s) / s;                      // world XZ only: a cell looks the same at any height / on any face
  float n = 0.6 * lavaNoise(q) + 0.4 * lavaNoise(q * 2.3 + 11.0);
  float heat = smoothstep(0.22, 0.65, n);
  vec3 crust = vec3(0.50, 0.08, 0.02);
  vec3 hot   = vec3(1.00, 0.45, 0.08);
  vec3 white = vec3(1.00, 0.88, 0.45);
  vec3 c = mix(crust, hot, heat);
  c = mix(c, white, smoothstep(0.65, 0.95, n) * 0.85);
  return c * 0.75 * (0.9 + uEmissive * 1.6 * heat);
}

// ------------------------------------------------------------ particles
// Explosion particles are axis-aligned cubes snapped to the voxel lattice (see particles.js).
// Nearest-hit wins, so there is no blend ordering to worry about. Transparency is done per voxel
// cell: a cube is opaque only in the cells whose hash is below its opacity, so smoke and dying
// flames dissolve voxel by voxel and rays pass through the gaps to whatever is behind.
bool traceParticles(vec3 ro, vec3 rd, float tMax, out float tBest, out vec3 nBest, out int iBest) {
  tBest = tMax; nBest = vec3(0.0); iBest = -1;
  if (uParticleCount == 0) return false;

  vec3  oc = uPBound.xyz - ro;                         // does this ray touch the particle cloud at all?
  float tc = dot(oc, rd);
  if (tc < -uPBound.w || dot(oc, oc) - tc * tc > uPBound.w * uPBound.w) return false;

  vec3 inv = 1.0 / rd;
  for (int i = 0; i < uParticleCount; i++) {
    vec4 A = texelFetch(uParticles, ivec2(0, i), 0);
    vec3 t0 = (A.xyz - A.w - ro) * inv;
    vec3 t1 = (A.xyz + A.w - ro) * inv;
    vec3 tmn = min(t0, t1), tmx = max(t0, t1);
    float tn = max(max(tmn.x, tmn.y), tmn.z);
    float tf = min(min(tmx.x, tmx.y), tmx.z);
    if (tn <= 0.0 || tn >= tBest || tf < tn) continue;   // behind the camera, camera inside, or farther than the nearest

    vec3 n = -sign(rd) * step(tmn.yzx, tmn) * step(tmn.zxy, tmn);
    vec4 B = texelFetch(uParticles, ivec2(1, i), 0);
    vec4 C = texelFetch(uParticles, ivec2(2, i), 0);
    ivec3 cell = ivec3(floor(ro + rd * tn - n * 0.5));    // the voxel cell this ray enters
    if (hash13(vec3(cell) + C.w * 131.0) >= B.w) continue; // dissolved cell: ray passes through

    tBest = tn; nBest = n; iBest = i;
  }
  return iBest >= 0;
}

// ------------------------------------------------------------ gun viewmodel
// Blocky guns fixed in camera space (x right, y up, z forward, in voxels), drawn over the scene.
// Boxes 0..6  = grenade launcher: 0 receiver, 1 barrel, 2 muzzle ring, 3 grip, 4 sight rail, 5 glowing energy cell, 6 foregrip.
// Boxes 7..13 = lava gun:         7 pump body, 8 wide nozzle, 9 glowing nozzle lip, 10 grip, 11 glowing lava tank, 12 feed pipe, 13 clamp ring.
// Index 14 is the muzzle flash. uGunType picks which set is drawn; both end near z = 24 so GUN_TIP in main.js fits both.
const int GUN_BOXES = 14;
const vec3 GUN_MIN[14] = vec3[14](
  vec3(3.6, -5.4,  7.0), vec3(4.1, -5.0, 17.0), vec3(3.9, -5.2, 22.5), vec3(4.1, -8.2,  8.0),
  vec3(4.5, -3.2,  9.0), vec3(3.5, -4.7,  9.5), vec3(4.3, -6.4, 13.0),
  vec3(3.8, -6.0,  8.0), vec3(4.0, -5.4, 16.0), vec3(3.8, -5.6, 23.0), vec3(4.3, -8.4,  9.0),
  vec3(3.9, -3.4,  8.5), vec3(4.5, -3.8, 15.0), vec3(3.9, -5.6, 19.5));
const vec3 GUN_MAX[14] = vec3[14](
  vec3(6.0, -3.2, 17.0), vec3(5.7, -3.4, 23.5), vec3(5.9, -3.2, 24.0), vec3(5.4, -5.4, 10.8),
  vec3(5.2, -2.6, 15.0), vec3(3.62, -3.9, 15.5), vec3(5.3, -5.4, 15.5),
  vec3(6.2, -3.4, 16.0), vec3(5.6, -3.0, 23.0), vec3(5.8, -2.8, 24.0), vec3(5.5, -6.0, 11.0),
  vec3(6.1, -0.8, 15.5), vec3(5.1, -3.0, 19.0), vec3(5.7, -2.9, 20.5));
const vec3 GUN_COL[14] = vec3[14](
  vec3(0.17, 0.18, 0.21), vec3(0.11, 0.11, 0.13), vec3(0.28, 0.27, 0.30), vec3(0.30, 0.16, 0.07),
  vec3(0.24, 0.24, 0.27), vec3(0.02, 0.02, 0.02), vec3(0.30, 0.16, 0.07),
  vec3(0.22, 0.10, 0.07), vec3(0.13, 0.12, 0.13), vec3(0.03, 0.02, 0.02), vec3(0.28, 0.15, 0.07),
  vec3(0.03, 0.02, 0.02), vec3(0.20, 0.20, 0.22), vec3(0.30, 0.29, 0.32));

// returns box index (0..13), 14 = muzzle flash, -1 = none
int traceGun(vec3 rdc, out float tBest, out vec3 nBest) {
  tBest = 1e9; nBest = vec3(0.0);
  int best = -1;
  vec3 inv = 1.0 / (rdc + vec3(1e-6));

  // one slab test against a box around every gun part (incl. muzzle flash): most pixels leave here
  {
    vec3 t0 = (vec3(3.4, -8.5, 6.9) + uGunOff) * inv, t1 = (vec3(6.3, -0.7, 30.1) + uGunOff) * inv;
    vec3 tmn = min(t0, t1), tmx = max(t0, t1);
    if (min(min(tmx.x, tmx.y), tmx.z) < max(max(max(tmn.x, tmn.y), tmn.z), 0.0)) return -1;
  }

  for (int i = 0; i < 15; i++) {
    vec3 bmin, bmax;
    if (i < GUN_BOXES) {
      if ((i < 7) != (uGunType < 0.5)) continue;                    // skip the other gun's boxes
      bmin = GUN_MIN[i] + uGunOff; bmax = GUN_MAX[i] + uGunOff;
    } else {
      if (uMuzzle < 0.03) break;
      bmin = vec3(3.5, -5.5, 24.0) + uGunOff;
      bmax = vec3(6.1, -2.9, 24.0 + 6.0 * uMuzzle) + uGunOff;
    }
    vec3 t0 = bmin * inv, t1 = bmax * inv;
    vec3 tmn = min(t0, t1), tmx = max(t0, t1);
    float tn = max(max(tmn.x, tmn.y), tmn.z);
    float tf = min(min(tmx.x, tmx.y), tmx.z);
    if (tn <= 0.0 || tn >= tBest || tf < tn) continue;
    vec3 n = -sign(rdc) * step(tmn.yzx, tmn) * step(tmn.zxy, tmn);
    if (i == 14) {                                                  // muzzle flash: voxels pop out as it fades
      vec3 c = floor((rdc * tn - n * 0.1) * 1.2);
      if (hash13(c + floor(uTime * 30.0)) > uMuzzle) continue;
    }
    tBest = tn; nBest = n; best = i;
  }
  return best;
}

vec3 shadeGun(int i, vec3 rdc, float t, vec3 nc) {
  vec3 pc = rdc * t;
  vec3 pw = uCamPos + uCamRight * pc.x + uCamUp * pc.y + uCamFwd * pc.z;
  vec3 nw = uCamRight * nc.x + uCamUp * nc.y + uCamFwd * nc.z;
  float v = 0.88 + 0.24 * hash13(floor((pc - nc * 0.1) * 1.6) + float(i) * 17.0);   // chunky per-voxel grit

  if (i == 14) {                                                      // muzzle flash (orange for the lava gun)
    vec3 fc = uGunType > 0.5 ? vec3(2.6, 1.25, 0.35) : vec3(2.6, 1.9, 0.9);
    return fc * (0.8 + 0.4 * v);
  }

  vec3 alb = GUN_COL[i] * v;
  vec3 lit = alb * 0.32;                                              // fill so it never goes fully black
  for (int k = 0; k < 8; k++) {
    if (k >= uLightCount) break;
    vec3  L = uLightPos[k] - pw;
    float d = length(L);
    float du = d * uInvScale;
    lit += alb * uLightCol[k] * max(dot(nw, L / d), 0.0) / (1.0 + 0.07 * du * du);
  }
  lit += alb * uGlowCol * glowAt(pw) * 0.8;                           // soaked in the glow of any lava nearby
  lit += alb * vec3(1.0, 0.55, 0.2) * uMuzzle * 1.5;                  // muzzle flash lights the barrel
  if (i == 5) lit += vec3(1.0, 0.45, 0.1) * (1.1 + 0.3 * sin(uTime * 5.0) + uMuzzle) * v;   // energy cell
  if (i == 9) lit += vec3(1.0, 0.42, 0.08) * (1.3 + 1.6 * uMuzzle) * v;                      // glowing nozzle lip
  if (i == 11) {                                                      // lava tank: slow churning bands, brighter while spraying
    float band = 0.5 + 0.5 * sin(pc.y * 2.2 + uTime * 2.5 + hash13(floor(pc * 1.2)) * 3.0);
    vec3 hot = mix(vec3(0.75, 0.16, 0.03), vec3(1.0, 0.72, 0.22), band);
    lit += hot * (1.0 + 0.8 * uMuzzle) * v;
  }
  return lit;
}

// ------------------------------------------------------------ main
#ifdef LIGHT_PASS
// Half-res light pass: trace the world at (resolution / 2) and cast the sky / sun / light rays there, once per texel.
// Output: rgb = sun + point lights (albedo 1, no AO); a = (faceCode * 2 + skyVisible) * 8192 + hitDistance.
// The full-res pass reuses a texel for every pixel that sees the same kind of surface at a similar distance.
void main() {
  vec2 uv = (gl_FragCoord.xy / uRes) * 2.0 - 1.0;
  uv.x *= uAspect;

  vec3 ro = uCamPos;
  vec3 rd = safeDir(uCamFwd + (uCamRight * uv.x + uCamUp * uv.y) * uTanHalf);

  vec4 o = vec4(0.0, 0.0, 0.0, 14.0 * 8192.0);              // face code 7 = nothing to reuse (sky, lava, emissive)
  Hit h = trace(ro, rd, MAX_COARSE, 1e5);
  if (h.hit && h.id != LAVA_ID && h.id != EMISSIVE_ID) {
    float vis;
    vec3 E = castLights(ro + rd * h.t, h.n, vis);
    o = vec4(E, (faceCode(h.n) * 2.0 + vis) * 8192.0 + min(h.t, 8000.0));
  }
  fragColor = o;
}
#else
void main() {
  vec2 uv = (gl_FragCoord.xy / uRes) * 2.0 - 1.0;
  uv.x *= uRes.x / uRes.y;

  vec3 ro = uCamPos;
  vec3 rd = safeDir(uCamFwd + (uCamRight * uv.x + uCamUp * uv.y) * uTanHalf);

  // viewmodel first: it is drawn over everything, so pixels it covers never need the world traced or lit
  vec3 rdc = vec3(dot(rd, uCamRight), dot(rd, uCamUp), dot(rd, uCamFwd));
  float gt; vec3 gn;
  int gi = traceGun(rdc, gt, gn);

  vec3 col;
  if (gi >= 0) {
    col = shadeGun(gi, rdc, gt, gn);
  } else {
    gSky = 0.0;
    Hit h = trace(ro, rd, MAX_COARSE, 1e5);
    float pt; vec3 pn; int pi;
    bool pHit = traceParticles(ro, rd, h.hit ? h.t : 1e9, pt, pn, pi);

    if (!pHit && !h.hit) {
      col = sky(rd);
    } else {
      // describe the nearest surface (world voxel or particle cube), then light it exactly once
      float t;  vec3 n, alb = vec3(0.0), add = vec3(0.0);
      float ao = 1.0;
      bool  lit = false;
      vec3  p;

      if (pHit) {
        // explosion particles: axis-aligned cubes on the voxel lattice (see particles.js)
        vec4 B = texelFetch(uParticles, ivec2(1, pi), 0);
        vec4 C = texelFetch(uParticles, ivec2(2, pi), 0);
        t = pt; n = pn; p = ro + rd * t;
        ivec3 cell = ivec3(floor(p - n * 0.5));
        float v = 0.85 + 0.3 * hash13(vec3(cell) + C.w * 53.0 + 7.0);   // per-voxel grit, like the world
        float face = n.y > 0.5 ? 1.0 : (n.y < -0.5 ? 0.55 : 0.8);       // top / side / bottom
        alb = B.rgb * v;
        lit = max(alb.r, max(alb.g, alb.b)) > 0.002;
        float fl = 0.75 + 0.5 * hash13(vec3(cell) + floor(uTime * 12.0) + C.w * 17.0);   // flames flicker per voxel
        add = C.rgb * fl * face * v;
      } else {
        t = h.t; n = h.n; p = ro + rd * t;
        if (h.id == LAVA_ID) {
          add = shadeLava(h, p);
        } else if (h.id == EMISSIVE_ID) {
          float fl = 0.85 + 0.3 * hash13(floor(vec3(h.cell) / uBlock) + floor(uTime * 8.0));
          add = uPalette[h.id] * uEmissive * fl;
        } else {
          alb = albedo(h.id, h.cell);
          ao  = faceAO(h.cell, h.n, p);
          lit = true;
        }
      }

      vec3 c = add;
      if (lit) {
        float vis; vec3 E;
#ifdef USE_LIGHT_BUFFER
        bool reuse = !pHit && fetchLight(t, n, E, vis);       // world surfaces borrow the half-res light pass
#else
        bool reuse = false;
#endif
        if (!reuse) E = castLights(p, n, vis);                // particles, silhouettes, or buffer disabled
        gSky = vis;
        c += shadeLit(p, n, alb, ao, E, vis);
      }
      col = applyFog(c, t);
    }
  }

  // tone + ordered dither
  col = pow(max(col, 0.0), vec3(0.6));
  float b = bayer8(ivec2(gl_FragCoord.xy));
  col = floor(col * (uLevels - 1.0) + 0.5 + (b - 0.5) * uDither) / (uLevels - 1.0);
  col = clamp(col, 0.0, 1.0);

  fragColor = vec4(col, 1.0);
}
#endif
`;