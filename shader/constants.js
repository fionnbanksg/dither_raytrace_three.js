// GLSL part 2/9: tunable constants (ray step budgets, light budget, feature switches).
// Performance knobs live here: SHADOW_COARSE, MAX_SHADOW_LIGHTS, USE_SUPER, SOFT_SCALE...

export default /* glsl */`layout(location = 0) out highp vec4 fragColor;

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

`;
