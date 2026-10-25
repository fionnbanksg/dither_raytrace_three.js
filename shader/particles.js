// GLSL part 7/9: explosion particle cubes (read from the uParticles texture, see particles.js).

export default /* glsl */`// ------------------------------------------------------------ particles
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

`;
