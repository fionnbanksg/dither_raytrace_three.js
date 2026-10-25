// GLSL part 8/9: first-person gun viewmodel (grenade launcher + lava gun), traced in camera space.

export default /* glsl */`// ------------------------------------------------------------ gun viewmodel
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

`;
