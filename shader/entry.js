// GLSL part 9/9: main() entry points. LIGHT_PASS = half-res light pass, else the full-res pass.
// The #ifdef/#endif pairs in here must stay balanced.

export default /* glsl */`// ------------------------------------------------------------ main
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
