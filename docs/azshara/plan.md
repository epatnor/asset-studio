<!-- PLAN.md -->

# Plan

## Work order

- [x] 1. Project folder, git init, CLAUDE.md (committed)
- [x] 2. Terrain generator + screenshot script (committed)
- [x] 2b. Terrain look pass: soft noise texture, hue shifts, greyscale value check (committed)
- [x] 3. Sea (committed)
- [x] 3b. Elongated island with three zones (committed)
- [x] 4. Spring and stream (committed)
- [x] 6. Grass, flowers, stones, reeds, fallen leaves (committed)
- [x] 7. Trees and bushes with wind (committed)
- [x] 8. Houses, path, lanterns (committed)
- [ ] L. Light and atmosphere pass (fog, sky, sun/moon, light shafts, darker reflective water)
- [ ] 5. Player with third-person camera
- [ ] 9. Start zone, POI, goal
- [ ] 10. Performance test on Winterspring (i5-4590T, Intel HD 4600)

## Done: step 2

- [x] project.godot with the Compatibility renderer
- [x] Layered heightmap: island falloff, warped hills, terraces, house plots, stream channel
- [x] Mesh with per-cell diagonal choice and smooth normals
- [x] `@tool` sliders plus Regenerate and Run checks buttons
- [x] Automated checks: stream profile, stream surface, walkable slopes, border, plots
- [x] Screenshot script: slope map, top-down, overview, low hills, along stream
- [x] All checks pass
- [x] User feedback: geometry approved, colours too contrasty
- [x] Save screenshots/step2/ as the comparison baseline
- [x] Commit step 2

## Done: step 2b, terrain look

- [x] Soft tiling noise texture (NoiseTexture2D) instead of per-pixel value noise
- [x] Hue shift with value: dark grass cooler and more saturated, light grass warmer
- [x] Subtle analogous colour patches at equal value, large rest areas (70/30)
- [x] Softer dirt and rock transitions, rock value closer to grass
- [x] Greyscale copy of every screenshot for value checks
- [x] Contact sheet (all views in one image) for quick review
- [x] User approval
- [x] Commit step 2b

## Done: step 3, sea

- [x] Sea node (`@tool`) that builds a large plane mesh in Godot code
- [x] Terrain heights passed to the water shader as a float texture, so water depth
      is known without reading the depth buffer (cheap on HD 4600)
- [x] Water shader: depth colour, transparency in the shallows, scrolling noise
      normal maps, small vertex swell, fresnel towards the sky colour
- [x] Shoreline foam with lapping bands, broken up by noise
- [x] Sky and fog horizon matched to the sea colour
- [x] Shore view in the screenshot script
- [x] Retune beach and sand colours against the water
- [x] Vertex swell dropped: invisible at 6 cm and needs a dense mesh; flat 8 km plane instead
- [x] Water reworked after play test: unshaded with own fresnel and sun glint,
      white foam, shore wave fronts with varying timing that dissolve into bubbles
- [x] F12 screenshots and walk mode in the debug camera
- [x] Procedural ground textures (grass, rock, gravel) from
      tools/textures/build_ground_textures.py, run with Blender's Python
- [x] Terrain shader uses them: tint times normalised detail, triplanar rock,
      gravel and sand at the shore
- [x] Player-eye screenshot views: along the beach, and beach with a visible ledge
- [x] Beach shelf layer in the generator: flat strip at sea level, bank behind,
      shallow offshore shelf; smoothed signed coast distance for a clean waterline
- [x] Fine yellow sand texture; all ground textures carry height in alpha
- [x] Height-based blending between grass, rock, gravel and sand
- [x] Swash running up the beach, synced with the sea waves through shared
      shader globals (shore_waves.gdshaderinc); sand stays wet and glossy a while
- [x] Water depth uses the exact terrain triangulation (no foam line offset)
- [x] Soft material transitions: noise-broken blend bands, blurred ledge mask,
      height blend mixed with crossfade, earthy fringe
- [x] Sea surface lifted near the shore in the vertex shader (dense coastal
      band on the terrain grid), so the real waterline runs up the beach
- [x] User play test, commit step 3

## Design plan: three zones on an elongated island

Goes into the existing steps rather than adding new ones:

- [x] Step 3b: elongate the island along one axis, add a
  zone value 0..1 along the long axis with noisy boundaries, pass it to the
  terrain shader. Move spring, stream, village plots into the start half.
  Terrain colour per zone: lush green, autumn ochre, grey-brown dead ground.
  Add a view per zone to the screenshot script. Also done: stochastic
  anti-tiling for grass, gravel and sand; dangerous end near monochrome
  black and grey, dark sand, dark rock, darker water around it.
- [x] Step 4, stream: ribbon water mesh along the carved bed at a fixed depth,
  flow ripples faster on steep stretches, streaky rapids, bank foam, spring
  pool with welling bubbles and faint rings. Shader hot reload while playing.
- Step 6, grass/stones/reeds: flower patches in the start zone, fallen leaves
  in the middle, sparse dry grass and rubble at the far end.
- Step 7, trees: three tree sets from Blender scripts (leafy, autumn, dead),
  chosen by zone value. Light shafts through the canopy along the path in the
  start zone (cheap fake: additive cards or a sun-shaft sprite, no volumetrics).
- Step 8, houses/path/lanterns: path runs from the village through the autumn
  zone to the portal.
- Step 9, start zone, POI, goal: cracked monuments as the POI on the far half,
  the magical portal as the goal.
- New, late: sky and light per zone. Sunny sky at the start, a stormy sky with
  dark clouds, darker fog and colder light near the portal, blended by the
  player's zone value. Must stay cheap on HD 4600 (sky shader, fog colour and
  sun energy lerps, no volumetric clouds).

## Order change (2026-10-12)

Patrik's call: assets first (steps 6 to 8), then a light and atmosphere pass,
then the player (step 5), then start zone, POI and goal.

## Current: step 6, ground dressing

- [x] Scatter node (`@tool`): chunked MultiMeshInstance3D per layer, visibility
      range per layer, deterministic seed, rules from terrain masks and zone
- [x] Grass clumps (procedural blades in Godot code), colour per zone via
      instance colour, wind in the vertex shader from shared wind globals
- [x] Flowers in the lush zone, fallen leaves in the autumn zone, sparse dry
      grass in the dark zone
- [x] Stones from a Blender build script (GLB, several variants)
- [x] Reeds along the stream and pool banks
- [x] Screenshot views close to the ground in each zone
- [x] Blades shrink into the ground near the end of their range
- [x] User play test: wind gust mask and baked stone textures added

## Done: step 7, trees and bushes

- [x] Blender build script: recursive skeleton + Skin modifier trunks, face
      budget, crowns of noise blobs with spherical custom normals
- [x] Leafy (also autumn), dead and bush variants; bark texture
- [x] Tree shader: object-space bark, leafy crown edges from a noise cut,
      fake translucency, wind lean with gusts and leaf flutter
- [x] Scattered by zone and forest noise, never on plots, beach or stream
- Later, if needed: real leaf cards on crown edges for stronger silhouettes

## Done: two islands and the stone bridge (2026-10-12)

- [x] Main island (lush east, autumn west) and dark island (old royal seat,
      corrupted), equal size, channel between, headlands with cliffs
- [x] Ancient stone bridge (Blender script, masonry texture, arches, broken
      parapets, fallen blocks in the water), landing plateaus on headlands
- [x] Spring, stream and village moved to the main island
- [x] Fix walkable slopes at channel cliffs and bridge landings (184 vertices)
- [x] Fix house plot 3 slope (13.9 deg)
- [x] Trees: visibility range raised to 460 m so they show across the channel
- [x] Dark island dressing: dead trees, bushes, stones (ruins in step 9)

## Done: step 8, houses, path, lanterns

- [x] Footpath from the village to the bridge (A*, shaped into the ground,
      drawn as trodden earth), automated path check
- [x] Three half-timbered houses from a Blender script (stone plinth,
      plaster, timber frame, windows, door, shingle roof, chimney), placed
      on the plots with the door facing the path, with collision
- [x] Lantern posts along the path with a warm omni light each
- [x] New textures: plaster, planks, shingles; prop shader with painted
      weathering
- [x] Placement follows the painted rock cover (no vegetation on rock)
- Later: torches on the bridge, lit windows at night (light pass)

## Design additions (Patrik, 2026-10-12)

Main island:
- Larger, with a valley in the middle holding a cosy lake: a small
  waterfall feeding it, a small wooden jetty (fishing practice later), and
  an islet in the lake with cherry blossom trees.

Dark island, three sub-biomes along the path from the bridge:
1. Abandoned, ghostly farmland (reference: Brill): dead fields, broken
   fences, collapsed barns, scarecrows.
2. A small village before the castle (reference: Moonbrook, Darkshire):
   ruined and boarded-up houses, a few still standing.
3. The castle of the old royal seat: broken towers, one tower still
   standing, a sick green glow in its highest window.
- The path continues across the dark island with different lantern posts,
  some broken or fallen.

Assets:
- Blender scripts stay the default for our own models.
- Patrik owns stylized Unreal packs. A headless export pipeline exists
  (Sandlåda/ue_export: glTF geometry, source textures, material manifest).
- LUSH Stylized Environment Set and FANTASTIC Village Pack both have the
  Standard licence but are marked NoAI on Fab ("Allows usage with AI: No").
  Claude does not process either pack or use them for inspiration; the
  LUSH test export was removed. Any other pack must be checked for both
  licence and the AI flag before Claude touches it.

## Done: lake valley on the larger main island

- [x] Main island larger (radius 110); village, spring and start moved east
- [x] Valley bowl with a lake (level 6 m), noise-perturbed shore with sand,
      islet with cherry blossom trees, rock shelf with a waterfall
- [x] Lake surface uses the water shader in still mode (no swash or fronts)
- [x] Jetty on the lake's east shore (Blender, with collision)
- [x] Debug minimap (M toggles, N zooms)
- Later: boulders and cliff meshes around the shelf, falling petals,
      a creek feeding the waterfall, lake outlet

## In progress: light and atmosphere pass (first experiment)

- [x] Sky shader: gradient, sun disc and glow, drifting painted clouds,
      storm gathering over the dark island, lightning flickers
- [x] Atmosphere node: blends sun, ambient, fog, ground fog, saturation and
      sky between the main island and the dark island by camera position
- [x] Low golden sun (elevation 26, from SSE), shadows to 140 m, glow
- [x] Global sun direction and sky colours for water, stream and trees
- [ ] Light shafts through the canopy
- [ ] Ground fog cards in the dark island lowlands
- [ ] Night or dusk variant, lanterns and torches as real light

## Design change: more biomes, world rebuild (Patrik, 2026-10-12)

Patrik plans to rebuild the world soon with more biomes, using Valheim's
biomes as a vocabulary (not a style to copy):
- Meadows: what the main island is now (lush, start, village, stream).
- Ashlands-like: the dark island as it is now (corrupted royal seat).
- Mountain: snow.
- Plains: open land, keeping our autumn theme.
- Dark forest, most important: dense pine and spruce forest.

Open questions for the rebuild: world size and layout, how biomes are
placed (a biome map instead of the single zone value), and whether
Terrain3D (clipmap LOD, editor sculpting and painting, Compatibility
supported since 1.0) replaces our terrain mesh while the generator keeps
producing the heightmap and masks. Conifer trees need their own Blender
builder. Do the light pass first.

## Next: Valheim-style light pass

From docs/visual_references.md (Valheim section):
- [ ] Denser cool-blue fog with strong sun scatter (warm only towards the sun)
- [ ] Saturated blue-teal ambient against a warm sun
- [ ] Stronger glow and bloom
- [ ] Darker, cooler ground under tree crowns (canopy mask)
- [ ] Light shafts through the canopy
- [ ] Drifting motes around the camera

## Status 2026-10-12 (end of session)

Done this session: continuous stream water, AI stream bed, natural stream
colour, Valheim-style light (fog, ambient, glow, canopy shade), volumetric
sunlight through canopy gaps (V toggles), drifting motes, AI textures for
gravel/sand/masonry/plaster/shingles, shore-aligned sand ripples, path bands
and bump relief, ground-matched grass, clustered AI ground-creeper cards,
Terrain3D add-on and import spike.

Tools: OpenRouter workspace budget (50 USD/month) is used up until
2026-11-01; 3D AI Studio API works (tools/textures/generate_3daistudio_image.py,
Gemini 3 Pro 2K = 50 credits, 355 credits left).

Next:
- [ ] Rule: no trees or bushes near lanterns, houses and the jetty
- [ ] Load time (~15 s): stream or cache the scatter
- [ ] Day and night cycle (volumetric light already follows the sun)
- [ ] World rebuild with biomes (meadows, dark forest, mountain, plains,
      ashlands) on Terrain3D, rule-table driven scatter

## Done: compass and day/night cycle (2026-10-13)

- [x] Compass fixed: north -Z (minimap top), east +X (start, zone 0),
      south +Z, west -X (dark island). Sun rises east, noon south, sets west.
- [x] `time_of_day` (0..24) on the atmosphere node; default 10:00 keeps the
      approved low sun (elevation ~26, azimuth ~34)
- [x] Time slider bottom left, `[` and `]` step half an hour
- [x] Day and night palettes for sky, fog and ambient; sun fades at night
- [x] Moon disc opposite the sun, night clouds take a blue tint
- Later: stars, dusk colours, lit windows and torches at night, play test

## First draft: clouds, weather and rain (2026-10-13)

- [x] Volumetric cloud slab in the sky shader: 6 marching steps, self-shadow
      towards the sun, cirrus to cumulus by cloud type, drift with the wind
- [x] Clouds dim sun and moon light and the ambient light; soft drifting cloud
      shadows on the terrain (terrain only for now)
- [x] Weather node: cover, cloud type, wind, rain; automatic cycle
- [x] Weather panel: sliders for clouds, cloud type, wind and rain
- [x] Rain particles follow the camera; off under a tree crown (crown check
      every 0.2 s, straight up only)
- [x] Screen rain streaks, a grey wash, and wind streaks in the wind direction
- [x] Trees and grass bend more with wind, gusts stronger
- Not yet: rain under houses, cloud shadows on trees and grass, snow (later),
  per-type cloud lighting tuning, performance on HD 4600
