// GLSL part 3/9: small utilities: voxel lookup, bounds, hash noise, 8x8 Bayer matrix.

export default /* glsl */`// ------------------------------------------------------------ helpers
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

`;
