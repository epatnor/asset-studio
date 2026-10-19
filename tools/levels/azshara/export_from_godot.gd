# Engångsexport till Tinkertown: kör terränggeneratorn och skriv höjder, masker och platser till filer.
extends SceneTree

const OUT := "res://export_tinkertown/out/"

func _v2(v: Vector2) -> Array: return [snappedf(v.x, 0.001), snappedf(v.y, 0.001)]
func _v3(v: Vector3) -> Array: return [snappedf(v.x, 0.001), snappedf(v.y, 0.001), snappedf(v.z, 0.001)]

func _initialize() -> void:
	DirAccess.make_dir_recursive_absolute(ProjectSettings.globalize_path(OUT))
	var holder := Node3D.new()
	root.add_child(holder)
	var t = load("res://scripts/terrain/terrain_generator.gd").new()
	t.name = "Terrain"
	t.auto_regenerate = false
	holder.add_child(t)
	if t.heights.is_empty():
		t.generate()
	var n: int = t.vertex_count_side
	var f := FileAccess.open(OUT + "heights.f32", FileAccess.WRITE)
	f.store_buffer(t.heights.to_byte_array())
	f.close()
	var groups := [["zone", "path_mask", "stream_mask"], ["lake_mask", "beach_mask", "cliff_mask"], ["rock_cover", "plot_mask", "ledge_mask"]]
	for gi in groups.size():
		var bytes := PackedByteArray()
		bytes.resize(n * n * 3)
		for c in 3:
			var arr: PackedFloat32Array = t.get(groups[gi][c])
			if arr.size() != n * n:
				continue
			for i in n * n:
				bytes[i * 3 + c] = int(clampf(arr[i], 0.0, 1.0) * 255.0 + 0.5)
		Image.create_from_data(n, n, false, Image.FORMAT_RGB8, bytes).save_png(OUT + "masks_%d.png" % gi)
	# Husen vänds mot närmaste stigpunkt (som village.gd)
	var houses := []
	for plot in t.house_plots:
		var c := Vector2(plot.x, plot.y)
		var best := c
		var bd := INF
		for p in t.path_points:
			var d := Vector2(p.x, p.z).distance_squared_to(c)
			if d < bd:
				bd = d
				best = Vector2(p.x, p.z)
		var facing := best - c
		houses.append({"pos": [plot.x, t.get_height(c.x, c.y), plot.y], "radius": plot.z, "yaw": atan2(facing.x, facing.y)})
	# Lyktstolpar längs stigen (som village.gd: var 16:e punkt, växelvis sida)
	var lanterns := []
	var pts: PackedVector3Array = t.path_points
	var side := 1.0
	var k := 8
	while k < pts.size() - 3:
		var p := pts[k]
		var ahead := pts[mini(k + 2, pts.size() - 1)]
		var along := Vector2(ahead.x - p.x, ahead.z - p.z).normalized()
		var nrm := Vector2(-along.y, along.x) * side
		var spot := Vector2(p.x, p.z) + nrm * 2.4
		lanterns.append({"pos": [spot.x, t.get_height(spot.x, spot.y), spot.y], "yaw": atan2(nrm.y, -nrm.x)})
		side = -side
		k += 16
	var meta := {
		"world_size": t.world_size, "cells": t.cells, "sea_level": 0.0, "channel_x": t.channel_x(),
		"main_center": _v2(t.main_center), "dark_center": _v2(t.dark_center), "island_radius": t.island_radius, "dark_radius": t.dark_radius,
		"island_aspect": t.island_aspect, "dark_aspect": t.dark_aspect,
		"bridge": {"start": [t.channel_x() - 46.0, t.bridge_deck_height, 0.0], "span": 92.0},
		"spring": _v2(t.spring_position), "spring_pool_radius": t.spring_pool_radius,
		"stream": {"half_width": t.stream_half_width, "water_depth": t.stream_water_depth, "points": Array(t.stream_points).map(_v3)},
		"path": {"half_width": t.path_half_width, "points": Array(t.path_points).map(_v3)},
		"lake": {"center": _v2(t.lake_center), "radius": t.lake_radius, "level": t.lake_level, "depth": t.lake_depth, "islet": _v2(t.lake_center + t.islet_offset), "islet_radius": t.islet_radius},
		"waterfall": {"angle": t._waterfall_angle, "base": _v2(t.waterfall_base()) if t.has_method("waterfall_base") else null, "height": t.waterfall_height},
		"houses": houses, "lanterns": lanterns,
		"masks": groups,
	}
	var j := FileAccess.open(OUT + "meta.json", FileAccess.WRITE)
	j.store_string(JSON.stringify(meta, " "))
	j.close()
	print("EXPORT OK n=%d houses=%d lanterns=%d stream=%d path=%d" % [n, houses.size(), lanterns.size(), t.stream_points.size(), t.path_points.size()])
	quit()
