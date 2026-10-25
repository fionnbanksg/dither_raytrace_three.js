// GLSL part 5/9: surface look: ambient occlusion, albedo, sky colour, fog, lava noise.

export default /* glsl */`// ------------------------------------------------------------ surface
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

`;
