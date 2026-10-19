<!-- docs/shore_and_water_notes.md -->

# Shore and water notes

Useful techniques collected from forum threads and tutorials, and how this
project applies them. Sources: a Procedural Worlds (Gaia) forum request
(2022), a Unity forum answer by Aras (2007), a Blender Stack Exchange answer
(2021) and the Cyanilux stylized shore shader breakdown (2024).

## Shaping the coastline

- Terrain that just slopes into the water like any hill reads as fake. Real
  beaches are a flat shelf at water level with a bank behind.
- Shape the coast as a post-process after the terrain is built: take the
  contour at water level, blur it into a soft distance field, and raise or
  lower the terrain along it with a profile. A blur parameter controls width
  and falloff. (Gaia request, option 1.)
- Here: `_build_beach()` in the terrain generator does exactly this with a
  blurred signed distance to the coastline.
- Later options if needed: painted shore stamps or coastline splines for
  hand-placed beaches, coves and river mouths (Gaia request, options 2 and 3).

## Getting a gradient towards the shore

- A shader alone knows nothing about neighbouring geometry. Prepare data for
  it in a script: water depth per vertex or a texture. (Aras.)
- Here: the terrain heightmap is a float texture for the sea shader, and the
  water mesh is built on the terrain grid with the same triangulation.
- The common modern alternative is reading the depth buffer and comparing
  scene depth with the water surface. It is automatic for any object in the
  water, but waves end up projected on the sea floor instead of lying on the
  surface, and it only looks right on flat shores seen from above. We avoid
  it for that reason and for cost. (Cyanilux.)
- A gradient in metres from the shore (Cyanilux uses a UV strip along the
  coast) gives evenly spaced, controllable wave bands. A depth gradient makes
  bands wider where the shore is flatter. Possible upgrade: pass the
  generator's smoothed coast distance to the sea shader as a texture.
- Masks from height: a wide band around sea level minus everything above it
  leaves a clean foam band on the water side. (Blender answer.)

## Waves, swash and wet sand

- Incoming waves: distort the shore gradient with noise, offset it with time,
  multiply and run it through fract or cos for repeated lines, thin them with
  smoothstep, fade them in towards the shore. Colour shallow water towards
  cyan, foam white. (Cyanilux.)
- Swash: an extra wave that runs up the sand and back, synced with the
  incoming waves through shared speed and count plus a time offset, given
  texture by noise, dissolving at its edge. (Cyanilux.)
- Here: shared timing lives in `shaders/shore_waves.gdshaderinc` as global
  shader parameters, the sea surface itself is lifted near the shore so the
  real waterline runs up the beach, and the swell has a direction so exposed
  coasts get big waves and the lee side small ones.
- Wet sand: behind the swash, darken the sand and raise its smoothness for a
  while instead of leaving it dry. Keep it subtle; strong gloss reads as a
  metallic band. (Cyanilux, and our own play tests.)

## Pitfalls we hit

- Foam bands measured in depth jump in width from triangle to triangle on a
  flat beach. Measure against a smoothed ground height, and compute the water
  level per pixel instead of interpolating it between vertices.
- A coastline taken straight from the grid becomes a staircase. Blur the
  signed distance before using it.
- Phase noise that varies too fast along the coast makes lumpy tongues of
  swash. Let a directional swell drive the timing, with little noise on top.

## WoW: Forever water (BlizzCon 2026 panel, second-hand summaries)

What made their remastered water read as believable, and what we can do
cheaply on our budget:

- Separate controls for waves, wind and flow. Wave size depends on the size
  of the body of water and reacts to the zone's wind. Here: the directional
  swell and exposure; later wind strength per zone.
- Rivers follow their bed, bend around rocks and foam where they hit
  obstacles. Here: flow along the ribbon with flow-map style two-phase
  animation. Next: rocks in the stream (step 6) write an obstacle mask so the
  shader adds foam and bends the flow around them.
- Each body of water has its own density, colour and light penetration depth
  (crystal-clear mountain lakes to murky swamps). Here: clarity_depth and
  colours per material; the dark zone's water is denser and greyer.
- Reflections of surroundings, sun and moon, changing with time of day and
  the water's motion. Here: a sky gradient reflection with Schlick fresnel
  and a sun glint. Planar reflections are too costly for the target; a
  baked or low-res cubemap of the sky per zone is a possible step up.
- Lighting matters as much as the water itself: sun shadows that move,
  volumetric fog with god rays, reduced bloom and saturation, every zone
  tuned by hand through the day. Their guess-level techniques: depth-based
  foam and colour, flow maps.

## Stream pitfalls we hit

- A channel carved from the centreline height spills where it runs along a
  slope: the downhill bank is lower than the water. Build levees up to the
  water level plus freeboard. Automated check: stream banks.
- Scrolling a texture by time times speed stretches it into stripes where
  speed changes along the stream. Use two phases that restart every cycle
  and crossfade (flow map technique).
- Overlapping transparent surfaces (pool disc and stream ribbon) show up as
  a lighter square. Start the ribbon at the pool rim.
- Water over a dark muddy bed reads as asphalt. Clear water over a visible
  pebble bed reads as a stream.
