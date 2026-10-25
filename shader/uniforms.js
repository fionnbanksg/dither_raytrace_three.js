// GLSL part 1/9: uniforms (values JS sends in each frame), the sky global and the output variable.
// Add a new uniform here, then register it in main.js `uniforms`.

export default /* glsl */`
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

`;
