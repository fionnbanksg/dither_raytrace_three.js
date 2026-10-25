# Refactor plan (staged)  -  stages 1-5 complete

## Project map (where to look)
| I want to change... | open |
|---|---|
| render quality, FOV, blast / gun tuning | `config.js` |
| how things look (lighting, sky, fog, gun model) | `shader/*.js` (see stage 1 table) |
| shader perf knobs | `shader/constants.js` |
| add a shader uniform | `shader/uniforms.js` + `render/uniforms.js` |
| GPU textures, partial uploads | `render/textures.js` |
| materials / render targets / resize | `render/pipeline.js` |
| torch, braziers, flashes, flicker | `game/lights.js` |
| aiming, firing, gun animation | `game/weapons.js` |
| F3 debug info | `game/debugHud.js` |
| explosions, per-frame order, startup | `main.js` |
| world gen / physics / lava / player | `world.js`, `physics.js`, `lava.js`, `player.js` (untouched) |


Rule for every stage: **behaviour must not change.** Move code, don't rewrite it.
After each stage run `npm run dev`, load the game, and check: it renders, you can walk,
shoot (left/right click), switch guns (G), and F3 shows the debug overlay.

## Stage 1 - split the shader  [DONE]
`shader.js` is now a ~20 line assembler. GLSL lives in `shader/`, one file per topic,
joined in this order (GLSL needs declare-before-use, so don't reorder):

| file | what is in it |
|---|---|
| `shader/vert.js` | fullscreen-quad vertex shader |
| `shader/uniforms.js` | every `uniform` + `fragColor` output |
| `shader/constants.js` | perf knobs (`SHADOW_COARSE`, `MAX_SHADOW_LIGHTS`, `USE_SUPER`...) |
| `shader/helpers.js` | voxel lookup, hash, Bayer dither matrix |
| `shader/trace.js` | 3-level DDA ray traversal, `occluded()` |
| `shader/surface.js` | AO, albedo, sky, fog |
| `shader/lighting.js` | lava glow, `castLights`, shading, light-buffer fetch, lava surface |
| `shader/particles.js` | explosion particle cubes |
| `shader/gun.js` | first-person gun viewmodel |
| `shader/entry.js` | `main()` for the half-res light pass and the full-res pass |

Verified: the assembled `frag`/`vert` strings are byte-identical to the old `shader.js`.
`main.js` still does `import { vert, frag } from './shader.js'`, and Vite hot reload still works.

To add a uniform: declare it in `shader/uniforms.js`, then add it to `uniforms` in `main.js`.

## Stage 2 - pull settings out of main.js  [DONE]
All tunable settings (`INTERNAL_HEIGHT`, `DITHER_*`, `FOV_DEG`, blast / gun / shake values, `SHOTS`, `GUN_TIP`...)
now live in `config.js`, each with its original comment. `main.js` imports them by name.
To tweak the feel of the game, edit `config.js` only. `main.js` went from 653 to about 650 lines
(the block was small; the big wins come in stages 3-5). Line numbers quoted in stages 3-5 are approximate (+/- 5).

## Stage 3 - renderer + textures  [DONE]
New `render/` folder. `main.js` shrank from ~650 to ~475 lines and calls these instead of building everything inline:

| file | what it exports |
|---|---|
| `render/textures.js` | `createWorldTextures(world)` -> `{voxelTex, coarseTex, superTex, refreshSuper}`; `createGlowTexture`; `createParticleTexture`; `createTextureUploader(renderer)` -> `uploadBox` (partial GPU upload after blasts / lava) |
| `render/uniforms.js` | `createUniforms({...})` builds the shared `uniforms` object; `applySkyUniforms(uniforms, st)` |
| `render/pipeline.js` | `createPipeline({renderer, canvas, uniforms})` -> `{material, lightMaterial, scene, lightScene, camera, lightRT, lightUniforms, useLightBuffer, resize}`; also owns the Vite shader hot-reload |

main.js keeps the same variable names (`material`, `uniforms`, `uploadBox`...), so the frame loop is untouched.
To add a uniform: declare in `shader/uniforms.js` AND add to `render/uniforms.js`.
Shader hot reload moved from the bottom of `main.js` into `render/pipeline.js`.

## Stage 4 - game systems  [DONE]
New `game/` folder. `main.js` is now ~355 lines (was 653).

| file | what is in it |
|---|---|
| `game/lights.js` | `createLights(world)`: light slot arrays, torch, braziers, the `flashes` list. Slot layout is documented at the top of the file |
| `game/weapons.js` | `createWeapons({...})` -> `{gun, lavaGun, aimGun, shoot, selectGun, animate}`. `gun` is the shared state object (`cooldown`, `kick`, `muzzle`, `swapT`, `lavaMode`, `wantLava`...). Also registers the G key |
| `game/debugHud.js` | `createDebugHud({...})`: the F3 overlay's stats snapshot. Read-only |

What deliberately stayed in `main.js` (stage 5 will tidy it): `detonate()` (explosions), the lava sim step + L key,
the per-frame light filling (torch, shells, flashes), the fire / swap logic in `frame()`, and the M / T / F3 hotkey listener.
Old loose variables became fields on `gun` (e.g. `gunCooldown` -> `gun.cooldown`, `swapT` -> `gun.swapT`).

## Stage 5 - slim the frame loop  [DONE]
`frame()` is now ~25 lines that call small named steps, in order. The steps live just above it in `main.js`:
`stepSimulation` -> `updateGunControls` -> `updatePlayer` -> `updateCamera` -> `lights.update` -> `weapons.animate`
-> `updateLava` -> `updateParticles` -> minimap -> `renderScene`.
The big light-filling block moved into `lights.update()` in `game/lights.js` (it now owns the torch state too).
Order matters a little (e.g. camera before lights, because the torch uses the camera's right vector), so keep it.
`main.js`: 653 -> ~335 lines. Setup at the top, `detonate()` in the middle, the loop steps at the bottom.

## Later / optional
- `world.js` (657 lines) and `physics.js` (368), `lava.js` (381): split only if you need to touch them.
- `test.html` (611 lines) looks like a standalone test page; check whether it is still used.
