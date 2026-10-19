<!-- docs/foliage_notes.md -->

# Foliage notes

How this project scatters vegetation, compared with Godot foliage tools
(research by Patrik, 2026-10-12: Foliage3D, godot-vegetator, Spatial
Gardener, Procedural Plant Generator, the MultiMeshInstance3D docs).

## What we do

- Scatter node (`scripts/scatter/scatter.gd`): jittered candidate points per
  chunk, filtered by rules on terrain masks, slope, zone and noise, seeded
  per chunk. One MultiMeshInstance3D per mesh and chunk, visibility range
  per layer. This is the same pattern Foliage3D uses.
- Plants are built by our own scripts (Blender for trees and stones, Godot
  code for grass), so no L-system plugin is needed.
- Tree crowns ("balls" style): smooth round masses with painted shading
  (warm light top, cool shadow below), and leaf tufts growing out of their
  surface. Each tuft card is anchored with its bottom edge inside the ball
  and rises outwards, tilted up to about 35 degrees from the surface normal,
  using a texture whose leaves fan up from the bottom edge. Nothing floats.
  Normals point out from the crown centre, so the crown shades as one mass.
- Compared with crossed cards (classic WoW), there are no visible planes from
  any angle; compared with a free shell of cards around a core, no card
  hangs loose outside the crown. The older "cards" style is still available
  in build_trees.py (CROWN_STYLE).

## Placement follows what the terrain shows (PCG rule)

- The generator computes rock cover with the same slope range and blurred
  ledge mask the terrain shader uses to paint rock (ROCK_SLOPE_START/END).
  Grass, flowers, leaves and trees fade out as rock cover rises; stones
  gather at the rock edges. So nothing grows on ground drawn as bare rock.
- Nothing grows on the footpath, the beach, the stream bed or the bridge
  landings; trees also keep off house plots.

## Ideas worth taking from the tools

- Seed placement by world position instead of chunk index (Foliage3D), so a
  plant stays put when chunk size or layer order changes.
- Replace instances near the camera with real scenes that have collision
  (Foliage3D). Needed for tree trunks and big stones when the player
  arrives in step 5: a few StaticBody3D capsules per nearby tree.
- Build chunks on worker threads (Foliage3D). Scattering takes about 3.6 s
  on the main thread today; threads or caching the result would cut load
  time.
- Avoid overlaps between layers (Vegetator): grass under bushes is fine, but
  trees should keep a minimum spacing; a simple occupancy grid per chunk.
- MultiMesh for close plants is fine as long as the meshes themselves do
  not intersect badly (Vegetator warns about branches cutting through each
  other up close).

## Pitfalls we hit

- Vertex colours do not survive MultiMesh in the Compatibility renderer;
  put per-vertex data in UV channels.
- Instance custom data is used as given: pass sRGB colours, not linear.
- glTF flips the V coordinate on export; data packed in UVs comes out as
  1 - v.
