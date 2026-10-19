# scripts/terrain/terrain_checks.gd
extends RefCounted

# Automated sanity checks for a generated TerrainGenerator.
# Each check returns a dictionary with name, passed and a human-readable detail.

# Tolerance for tiny bumps when sampling the carved mesh along the stream.
const STREAM_SAMPLE_TOLERANCE := 0.05
const STREAM_SAMPLE_SPACING := 0.5


static func run(terrain) -> Array[Dictionary]:
	var results: Array[Dictionary] = []
	results.append(_check_stream_profile(terrain))
	results.append(_check_stream_surface(terrain))
	results.append(_check_stream_banks(terrain))
	results.append(_check_walkable_slopes(terrain))
	results.append(_check_border(terrain))
	results.append(_check_plots(terrain))
	results.append(_check_path(terrain))
	return results


static func _result(name: String, passed: bool, detail: String) -> Dictionary:
	return {"name": name, "passed": passed, "detail": detail}


# The bed profile must strictly decrease, start above sea level and end below it.
static func _check_stream_profile(terrain) -> Dictionary:
	var points: PackedVector3Array = terrain.stream_points
	if points.size() < 2:
		return _result("stream profile", false, "no stream path")
	var rises := 0
	for k in range(1, points.size()):
		if points[k].y >= points[k - 1].y:
			rises += 1
	var start := points[0].y
	var end := points[points.size() - 1].y
	var passed: bool = rises == 0 and start > terrain.SEA_LEVEL and end < terrain.SEA_LEVEL
	return _result("stream profile", passed,
		"%d points, bed %.2f m -> %.2f m, %d non-decreasing steps" % [points.size(), start, end, rises])


# The actual carved terrain sampled along the centerline must never rise
# by more than a small tolerance. Sampling starts at the rim of the spring
# pool, since the pool is meant to be deeper than the stream leaving it.
static func _check_stream_surface(terrain) -> Dictionary:
	var points: PackedVector3Array = terrain.stream_points
	if points.size() < 2:
		return _result("stream surface", false, "no stream path")
	var previous := INF
	var worst_rise := 0.0
	var worst_at := Vector2.ZERO
	for k in points.size() - 1:
		var a := Vector2(points[k].x, points[k].z)
		var b := Vector2(points[k + 1].x, points[k + 1].z)
		var steps := maxi(int(a.distance_to(b) / STREAM_SAMPLE_SPACING), 1)
		for s in steps:
			var p := a.lerp(b, float(s) / steps)
			if p.distance_to(Vector2(points[0].x, points[0].z)) < terrain.spring_pool_radius:
				continue
			var h: float = terrain.get_height(p.x, p.y)
			if h - previous > worst_rise:
				worst_rise = h - previous
				worst_at = p
			previous = h
	var passed := worst_rise <= STREAM_SAMPLE_TOLERANCE
	return _result("stream surface", passed,
		"largest rise %.3f m at (%.1f, %.1f)" % [worst_rise, worst_at.x, worst_at.y])


# The ground beside the channel, at the levee crest on both sides, must be
# above the water surface, so the water never spills over its banks. The
# spring pool is skipped; its own rim is part of the pool.
static func _check_stream_banks(terrain) -> Dictionary:
	var points: PackedVector3Array = terrain.stream_points
	var spills := 0
	var worst := 0.0
	var worst_at := Vector2.ZERO
	var reach: float = terrain.stream_half_width + terrain.stream_levee_width
	for k in range(1, points.size() - 1):
		var level: float = points[k].y + terrain.stream_water_depth
		if level < terrain.SEA_LEVEL:
			continue
		var from_spring := Vector2(points[k].x - points[0].x, points[k].z - points[0].z).length()
		if from_spring < terrain.spring_pool_radius + reach:
			continue
		var tangent := Vector2(points[k + 1].x - points[k - 1].x, points[k + 1].z - points[k - 1].z).normalized()
		var side := Vector2(-tangent.y, tangent.x)
		for sign in [-1.0, 1.0]:
			var p: Vector2 = Vector2(points[k].x, points[k].z) + side * reach * sign
			var below: float = level - terrain.get_height(p.x, p.y)
			if below > 0.02:
				spills += 1
				if below > worst:
					worst = below
					worst_at = p
	return _result("stream banks", spills == 0,
		"%d bank samples below the water, worst %.2f m at (%.1f, %.1f)" % [spills, worst, worst_at.x, worst_at.y])


# Every land vertex outside the ledge mask must be walkable.
static func _check_walkable_slopes(terrain) -> Dictionary:
	var limit := deg_to_rad(terrain.walkable_slope_deg)
	var too_steep := 0
	var steep_near_stream := 0
	var steep_near_plots := 0
	var land := 0
	var steepest := 0.0
	var steepest_at := Vector2.ZERO
	var n: int = terrain.vertex_count_side
	for idx in terrain.heights.size():
		if terrain.heights[idx] <= terrain.SEA_LEVEL:
			continue
		if terrain.ledge_mask[idx] > terrain.ledge_ignore_threshold:
			continue
		land += 1
		var angle := acos(clampf(terrain.normals[idx].y, -1.0, 1.0))
		if angle > limit:
			too_steep += 1
			if terrain.stream_mask[idx] > 0.0:
				steep_near_stream += 1
			if terrain.plot_mask[idx] > 0.0:
				steep_near_plots += 1
		if angle > steepest:
			steepest = angle
			steepest_at = terrain.vertex_position_2d(idx % n, idx / n)
	return _result("walkable slopes", too_steep == 0,
		"%d of %d land vertices above %.0f deg (%d near stream, %d near plots), steepest %.1f deg at (%.1f, %.1f)" % [
			too_steep, land, terrain.walkable_slope_deg, steep_near_stream, steep_near_plots,
			rad_to_deg(steepest), steepest_at.x, steepest_at.y])


# All vertices on the outer edge of the grid must be under water.
static func _check_border(terrain) -> Dictionary:
	var n: int = terrain.vertex_count_side
	var highest := -INF
	for k in n:
		for idx in [k, (n - 1) * n + k, k * n, k * n + n - 1]:
			highest = maxf(highest, terrain.heights[idx])
	var passed: bool = highest < terrain.SEA_LEVEL - terrain.border_margin
	return _result("island border", passed,
		"highest border vertex %.2f m (limit %.2f m)" % [highest, terrain.SEA_LEVEL - terrain.border_margin])


# House plots must be above water, flat and clear of the stream banks.
static func _check_plots(terrain) -> Dictionary:
	var problems := PackedStringArray()
	var n: int = terrain.vertex_count_side
	var stream_reach: float = terrain.stream_half_width + terrain.stream_bank_width
	for plot_index in terrain.house_plots.size():
		var plot: Vector3 = terrain.house_plots[plot_index]
		var center := Vector2(plot.x, plot.y)
		var center_height: float = terrain.get_height(center.x, center.y)
		if center_height < terrain.SEA_LEVEL + 1.0:
			problems.append("plot %d too low (%.2f m)" % [plot_index, center_height])
		var steepest := 0.0
		for idx in terrain.heights.size():
			if terrain.vertex_position_2d(idx % n, idx / n).distance_to(center) <= plot.z - terrain.cell_size:
				steepest = maxf(steepest, rad_to_deg(acos(clampf(terrain.normals[idx].y, -1.0, 1.0))))
		if steepest > terrain.plot_max_slope_deg:
			problems.append("plot %d slope %.1f deg" % [plot_index, steepest])
		for point in terrain.stream_points:
			var gap := Vector2(point.x, point.z).distance_to(center) - plot.z - stream_reach
			if gap < 0.0:
				problems.append("plot %d overlaps stream" % plot_index)
				break
	var passed := problems.is_empty()
	var detail := "%d plots ok" % terrain.house_plots.size() if passed else ", ".join(problems)
	return _result("house plots", passed, detail)


# The footpath must exist, reach the bridge landing and stay gentle.
static func _check_path(terrain) -> Dictionary:
	var points: PackedVector3Array = terrain.path_points
	if points.size() < 2:
		return _result("path", false, "no path found")
	var steepest := 0.0
	for k in range(1, points.size()):
		var run := Vector2(points[k].x - points[k - 1].x, points[k].z - points[k - 1].z).length()
		steepest = maxf(steepest, rad_to_deg(atan2(absf(points[k].y - points[k - 1].y), maxf(run, 0.001))))
	var end := Vector2(points[points.size() - 1].x, points[points.size() - 1].z)
	var landing := Vector2(terrain.channel_x() + terrain.BRIDGE_HALF_SPAN + 2.0, 0.0)
	var passed := steepest < 25.0 and end.distance_to(landing) < 1.0
	return _result("path", passed, "%d m long, steepest %.1f deg" % [points.size(), steepest])
