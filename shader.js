// Fullscreen-quad voxel raymarcher (Amanatides & Woo DDA) + ordered dithering.
// Rendered at a tiny internal resolution and upscaled with nearest-neighbour by CSS.

export const vert = /* glsl */`
void main() {
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

export const frag = /* glsl */`
uniform sampler3D uVoxels;
uniform vec3  uSize;
uniform vec3  uCamPos;
uniform vec3  uCamFwd;
uniform vec3  uCamRight;
uniform vec2  uRes;
uniform float uTanHalf;
uniform float uTime;
uniform float uLevels;       // colour levels per channel after dithering
uniform float uTorch;        // torch brightness
uniform vec3  uPalette[8];

const int MAX_STEPS = 128;

int voxelAt(ivec3 p) {
  return int(texelFetch(uVoxels, p, 0).r * 255.0 + 0.5);
}

float hash13(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.zyx + 31.32);
  return fract((p.x + p.y) * p.z);
}

// 8x8 Bayer matrix, computed with bit tricks (value in 0..1)
float bayer8(ivec2 p) {
  int x = p.x & 7, y = p.y & 7;
  int a = x ^ y;
  int v = ((a & 1) << 5) | ((y & 1) << 4) | ((a & 2) << 2) | ((y & 2) << 1) | ((a & 4) >> 1) | ((y & 4) >> 2);
  return (float(v) + 0.5) / 64.0;
}

vec3 sky(vec3 rd) {
  float star = step(0.9975, hash13(floor(rd * 160.0)));
  return vec3(0.008, 0.012, 0.03) + star * 0.7;
}

void main() {
  vec2 uv = (gl_FragCoord.xy / uRes) * 2.0 - 1.0;
  uv.x *= uRes.x / uRes.y;

  vec3 ro = uCamPos;
  vec3 rd = normalize(uCamFwd + (uCamRight * uv.x + vec3(0.0, 1.0, 0.0) * uv.y) * uTanHalf + 1e-5);

  // --- voxel DDA ---
  ivec3 cell = ivec3(floor(ro));
  vec3 stp  = sign(rd);
  vec3 dlt  = abs(1.0 / rd);
  vec3 side = (stp * (vec3(cell) - ro + 0.5) + 0.5) * dlt;
  vec3 mask = vec3(0.0);
  int  id = 0;
  bool hit = false;

  for (int i = 0; i < MAX_STEPS; i++) {
    if (any(lessThan(cell, ivec3(0))) || any(greaterThanEqual(cell, ivec3(uSize)))) break;
    id = voxelAt(cell);
    if (id > 0) { hit = true; break; }
    mask = step(side, side.yzx) * step(side, side.zxy);
    side += mask * dlt;
    cell += ivec3(mask * stp);
  }

  vec3 col;
  if (hit) {
    float t = dot(mask, side - dlt);          // distance to the hit face
    vec3  n = -mask * stp;                    // face normal
    vec3  base = uPalette[id];

    // per-voxel brightness jitter gives the chunky look
    base *= 0.72 + 0.5 * hash13(vec3(cell));

    // torch carried by the party
    float flick = 1.0 + 0.05 * sin(uTime * 9.0) + 0.03 * sin(uTime * 23.0);
    float atten = uTorch * flick / (1.0 + 0.06 * t * t);
    float ndl   = max(dot(n, -rd), 0.0);
    float face  = n.y > 0.5 ? 1.0 : (n.y < -0.5 ? 0.55 : 0.85);

    col = base * (0.05 + atten * ndl * face);
    col *= exp(-t * 0.03);
  } else {
    col = sky(rd);
  }

  // --- tone + ordered dither ---
  col = pow(max(col, 0.0), vec3(0.55));
  float b = bayer8(ivec2(gl_FragCoord.xy));
  col = floor(col * (uLevels - 1.0) + b) / (uLevels - 1.0);

  gl_FragColor = vec4(col, 1.0);
}
`;
