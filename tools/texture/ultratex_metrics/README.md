# UltraTex seam metrics

These are the measurements behind the tables in docs/ultratex-4b.md. Each script prints one line of JSON per model.

- `turntable.sh <out_root> <label> <glb>`: renders 36 head shots, 10 degrees apart, at 320 px. Run it on the worker; it uses Blender and `/data/runner/render_views.py`.
- `turn_metric.py <root> <base> <models...>`: measures jumps. It takes the optical flow between frames from the base render (Pixal3D's own paint), warps each model's frame onto the next one with it, and reports the residual beyond the base's (`excess_mean`, `excess_worst`).
- `offset_metric.py <root> <base> <models...>`: measures how far the paint sits from the base at the face angles, as the median and p95 in px.
- `sharp_metric.py <root> <models...>`: measures sharpness as the Laplacian variance over the figure at the face angles.
