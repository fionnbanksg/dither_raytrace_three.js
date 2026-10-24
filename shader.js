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
uniform vec3  uPalette[10];
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

float gSky = 0.0;               // sky visibility of the last lit surface (0 indoors): drives distance fog colour

layout(location = 0) out highp vec4 fragColor;

const int BRICK         = 8;
const int MAX_COARSE    = 200;
const int SHADOW_COARSE = 100;
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

// Lava glows, it doesn't block light: shadow rays step through it (a few voxels at a time) and keep going.
bool occluded(vec3 ro, vec3 rd, float dist) {
  float t0 = 0.0;
  for (int k = 0; k < 6; k++) {
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

// Ambient + every light with a (jittered, soft) shadow ray. Shared by world voxels and particle cubes.
vec3 lightSurface(vec3 p, vec3 n, vec3 alb, float ao) {
  vec3  lit = alb * vec3(0.6, 0.7, 1.0) * uAmbient * ao;

  vec3 sp = p + n * 0.3;                                    // shadow ray origin

  // open sky: ambient from above (only where the sky can be seen) + one sun / moon shadow ray
  vec3 sj = vec3(hash13(vec3(gl_FragCoord.xy, 41.0)), hash13(vec3(gl_FragCoord.xy, 43.0)), hash13(vec3(gl_FragCoord.xy, 47.0))) - 0.5;
  float vis = occluded(sp, safeDir(vec3(0.0, 0.9, 0.0) + n * 0.5 + sj * 0.8), 700.0) ? 0.0 : 1.0;
  gSky = vis;
  lit += alb * uSkyAmb * vis * (0.55 + 0.45 * n.y) * mix(1.0, ao, 0.7);
  float sn = max(dot(n, uCelLightDir), 0.0);
  if (sn > 0.0 && max(uCelLightCol.r, max(uCelLightCol.g, uCelLightCol.b)) > 0.004 &&
      !occluded(sp, safeDir(uCelLightDir + sj * 0.05), 900.0)) {
    lit += alb * uCelLightCol * sn * mix(1.0, ao, 0.6);
  }
  for (int i = 0; i < 8; i++) {
    if (i >= uLightCount) break;

    vec3  L = uLightPos[i] - sp;
    float d = length(L);
    L /= d;
    float ndl = max(dot(n, L), 0.0);
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
    vec3  target = uLightPos[i] + jit * (i == 0 ? 0.0 : uSoft);   // torch: hard shadow, other lights stay soft
    if (solidAt(ivec3(floor(target)))) target = uLightPos[i];     // never aim a shadow ray into stone
    vec3  sd = target - sp;
    float sl = length(sd);
    if (occluded(sp, safeDir(sd), sl - 0.05)) continue;

    lit += alb * contrib * mix(1.0, ao, 0.6);
  }
  return lit + lavaGlow(p, n, alb, ao);
}


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

vec3 shade(Hit h, vec3 ro, vec3 rd) {
  vec3 p = ro + rd * h.t;

  if (h.id == LAVA_ID) return shadeLava(h, p);

  if (h.id == EMISSIVE_ID) {
    float fl = 0.85 + 0.3 * hash13(floor(vec3(h.cell) / uBlock) + floor(uTime * 8.0));
    return uPalette[h.id] * uEmissive * fl;
  }

  vec3  alb = albedo(h.id, h.cell);
  float ao  = faceAO(h.cell, h.n, p);
  return lightSurface(p, h.n, alb, ao);
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

vec3 shadeParticle(int i, vec3 ro, vec3 rd, float t, vec3 n) {
  vec4 B = texelFetch(uParticles, ivec2(1, i), 0);
  vec4 C = texelFetch(uParticles, ivec2(2, i), 0);
  vec3 p = ro + rd * t;
  ivec3 cell = ivec3(floor(p - n * 0.5));
  float v = 0.85 + 0.3 * hash13(vec3(cell) + C.w * 53.0 + 7.0);   // per-voxel grit, like the world
  float face = n.y > 0.5 ? 1.0 : (n.y < -0.5 ? 0.55 : 0.8);       // top / side / bottom, so cubes read as cubes

  vec3 col = vec3(0.0);
  vec3 alb = B.rgb * v;
  if (max(alb.r, max(alb.g, alb.b)) > 0.002) col = lightSurface(p, n, alb, 1.0);

  // flames: each voxel flickers on its own
  float fl = 0.75 + 0.5 * hash13(vec3(cell) + floor(uTime * 12.0) + C.w * 17.0);
  col += C.rgb * fl * face * v;
  return col;
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
void main() {
  vec2 uv = (gl_FragCoord.xy / uRes) * 2.0 - 1.0;
  uv.x *= uRes.x / uRes.y;

  vec3 ro = uCamPos;
  vec3 rd = safeDir(uCamFwd + (uCamRight * uv.x + uCamUp * uv.y) * uTanHalf);

  gSky = 0.0;
  Hit h = trace(ro, rd, MAX_COARSE, 1e5);
  vec3 col;
  if (h.hit) {
    col = applyFog(shade(h, ro, rd), h.t);
  } else {
    col = sky(rd);
  }

  float pt; vec3 pn; int pi;
  if (traceParticles(ro, rd, h.hit ? h.t : 1e9, pt, pn, pi)) {
    col = applyFog(shadeParticle(pi, ro, rd, pt, pn), pt);
  }

  // viewmodel on top
  vec3 rdc = vec3(dot(rd, uCamRight), dot(rd, uCamUp), dot(rd, uCamFwd));
  float gt; vec3 gn;
  int gi = traceGun(rdc, gt, gn);
  if (gi >= 0) col = shadeGun(gi, rdc, gt, gn);

  // tone + ordered dither
  col = pow(max(col, 0.0), vec3(0.6));
  float b = bayer8(ivec2(gl_FragCoord.xy));
  col = floor(col * (uLevels - 1.0) + 0.5 + (b - 0.5) * uDither) / (uLevels - 1.0);
  col = clamp(col, 0.0, 1.0);

  fragColor = vec4(col, 1.0);
}
`;