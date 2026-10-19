# scripts/terrain/terrain_generator.gd
@tool
class_name TerrainGenerator
extends Node3D

# Generates the terrain of two islands as a layered heightmap and builds a
# mesh from it: the main island (lush in the east, autumn in the west) and
# the dark island further west, separated by a channel. Both rise towards
# the channel and meet it in cliffs, where a bridge crosses.
# Layers, in order: island falloff with a perturbed coastline, rolling hills
# with domain warping, masked terrace steps, the beach shelf, flattened house
# plots and finally the stream channel carved from the spring to the sea.
# The mesh lives in an internal child node that is never saved with the scene.

signal generated

const SEA_LEVEL := 0.0
const BEACH_SMOOTHING := 0.6
const BEACH_LIP := 0.12

# How far the zone value climbs across the main island (east to west end);
# the dark island is zone 1.
const MAIN_ZONE_SPAN := 0.55

# Half the bridge span (see scripts/bridge/bridge.gd).
const BRIDGE_HALF_SPAN := 46.0

# Bridge landing plateau: length beyond the bridge end, half width, overlap
# under the bridge end, and the slopes of the ramp inland and its shoulders.
const LANDING_LENGTH := 10.0
const LANDING_HALF_WIDTH := 5.0
const LANDING_OVERLAP := 3.0
const LANDING_RAMP_DEG := 16.0
const LANDING_SHOULDER_DEG := 26.0

# Slope range (1 - normal.y) over which the terrain shader turns ground into
# rock; must match rock_slope_start/end in terrain.gdshader.
const ROCK_SLOPE_START := 0.12
const ROCK_SLOPE_END := 0.42

# Grid size in metres for the path search.
const PATH_CELL := 4.0
const PATH_MAX_BLEND := 12.0

# Steepest step the path search may take (rise over run); ledges and cliffs
# are steeper than this, so the path goes around them.
const PATH_MAX_GRADE := 0.5
const TerrainChecks := preload("res://scripts/terrain/terrain_checks.gd")
const DEFAULT_MATERIAL := preload("res://materials/terrain_material.tres")

@export_tool_button("Regenerate", "Reload") var regenerate_button: Callable = generate
@export_tool_button("Run checks", "StatusSuccess") var run_checks_button: Callable = print_checks
@export var auto_regenerate := true
@export var terrain_material: Material

@export_group("Grid")
@export var world_size := 784.0:
	set(value):
		world_size = value
		_queue_regenerate()
@export_range(32, 1024, 1) var cells := 784:
	set(value):
		cells = value
		_queue_regenerate()
@export_range(0.0, 0.5, 0.01) var diagonal_bias := 0.02:
	set(value):
		diagonal_bias = value
		_queue_regenerate()

@export_group("Island")
@export var noise_seed := 1337:
	set(value):
		noise_seed = value
		_queue_regenerate()
@export_range(20.0, 200.0, 1.0) var island_radius := 110.0:
	set(value):
		island_radius = value
		_queue_regenerate()
@export_range(1.0, 80.0, 0.5) var coast_width := 55.0:
	set(value):
		coast_width = value
		_queue_regenerate()
@export_range(0.0, 0.5, 0.01) var coast_noise_amount := 0.18:
	set(value):
		coast_noise_amount = value
		_queue_regenerate()
@export_range(0.1, 5.0, 0.05) var coast_noise_scale := 1.5:
	set(value):
		coast_noise_scale = value
		_queue_regenerate()
@export_range(1.0, 4.0, 0.05) var island_aspect := 1.7:
	set(value):
		island_aspect = value
		_queue_regenerate()
@export var main_center := Vector2(178.0, 0.0):
	set(value):
		main_center = value
		_queue_regenerate()
@export var dark_center := Vector2(-212.0, 0.0):
	set(value):
		dark_center = value
		_queue_regenerate()
@export_range(20.0, 200.0, 1.0) var dark_radius := 90.0:
	set(value):
		dark_radius = value
		_queue_regenerate()
@export_range(1.0, 4.0, 0.05) var dark_aspect := 1.7:
	set(value):
		dark_aspect = value
		_queue_regenerate()
@export_range(0.0, 40.0, 0.5) var headland_height := 12.0:
	set(value):
		headland_height = value
		_queue_regenerate()
@export_range(0.0, 40.0, 0.5) var bridge_deck_height := 20.6:
	set(value):
		bridge_deck_height = value
		_queue_regenerate()
@export_range(2.0, 60.0, 0.5) var cliff_coast_width := 14.0:
	set(value):
		cliff_coast_width = value
		_queue_regenerate()
@export_range(0.0, 20.0, 0.1) var land_height := 4.0:
	set(value):
		land_height = value
		_queue_regenerate()
@export_range(0.0, 20.0, 0.1) var center_rise := 5.0:
	set(value):
		center_rise = value
		_queue_regenerate()
@export_range(1.0, 30.0, 0.1) var sea_depth := 6.0:
	set(value):
		sea_depth = value
		_queue_regenerate()

@export_group("Zones")
@export_range(0.0, 0.3, 0.01) var zone_noise_amount := 0.08:
	set(value):
		zone_noise_amount = value
		_queue_regenerate()
@export_range(0.001, 0.05, 0.001) var zone_noise_frequency := 0.012:
	set(value):
		zone_noise_frequency = value
		_queue_regenerate()

@export_group("Hills")
@export_range(0.0, 20.0, 0.1) var hill_height := 6.0:
	set(value):
		hill_height = value
		_queue_regenerate()
@export_range(0.001, 0.1, 0.001) var hill_frequency := 0.012:
	set(value):
		hill_frequency = value
		_queue_regenerate()
@export_range(1, 6, 1) var hill_octaves := 3:
	set(value):
		hill_octaves = value
		_queue_regenerate()
@export_range(0.0, 1.0, 0.01) var hill_gain := 0.35:
	set(value):
		hill_gain = value
		_queue_regenerate()
@export_range(0.0, 80.0, 0.5) var warp_amplitude := 25.0:
	set(value):
		warp_amplitude = value
		_queue_regenerate()
@export_range(0.001, 0.05, 0.001) var warp_frequency := 0.008:
	set(value):
		warp_frequency = value
		_queue_regenerate()

@export_group("Terraces")
@export_range(0.5, 10.0, 0.1) var terrace_step := 2.5:
	set(value):
		terrace_step = value
		_queue_regenerate()
@export_range(0.05, 1.0, 0.01) var terrace_edge := 0.25:
	set(value):
		terrace_edge = value
		_queue_regenerate()
@export_range(0.0, 1.0, 0.01) var terrace_strength := 1.0:
	set(value):
		terrace_strength = value
		_queue_regenerate()
@export_range(0.001, 0.1, 0.001) var terrace_mask_frequency := 0.01:
	set(value):
		terrace_mask_frequency = value
		_queue_regenerate()
@export_range(-1.0, 1.0, 0.01) var terrace_mask_threshold := 0.0:
	set(value):
		terrace_mask_threshold = value
		_queue_regenerate()
@export_range(0.1, 1.0, 0.01) var terrace_inland := 0.95:
	set(value):
		terrace_inland = value
		_queue_regenerate()
@export_range(0.0, 60.0, 1.0) var ledge_min_slope_deg := 20.0:
	set(value):
		ledge_min_slope_deg = value
		_queue_regenerate()

@export_group("House plots")
@export var house_plots := PackedVector3Array([
	Vector3(258.0, -22.0, 6.0),
	Vector3(286.0, -6.0, 6.0),
	Vector3(236.0, -26.0, 5.0),
	Vector3(278.0, 12.0, 5.0),
]):
	set(value):
		house_plots = value
		_queue_regenerate()
@export_range(0.5, 30.0, 0.5) var plot_blend := 6.0:
	set(value):
		plot_blend = value
		_queue_regenerate()
@export_range(1.0, 40.0, 0.5) var plot_max_blend := 16.0:
	set(value):
		plot_max_blend = value
		_queue_regenerate()
@export_range(5.0, 60.0, 1.0) var plot_blend_max_slope_deg := 30.0:
	set(value):
		plot_blend_max_slope_deg = value
		_queue_regenerate()

@export_group("Beach")
@export_range(0.0, 40.0, 0.5) var beach_width := 10.0:
	set(value):
		beach_width = value
		_queue_regenerate()
@export_range(0.0, 3.0, 0.05) var beach_rise := 0.6:
	set(value):
		beach_rise = value
		_queue_regenerate()
@export_range(0.0, 40.0, 0.5) var beach_offshore := 10.0:
	set(value):
		beach_offshore = value
		_queue_regenerate()
@export_range(0.0, 5.0, 0.05) var beach_offshore_depth := 0.7:
	set(value):
		beach_offshore_depth = value
		_queue_regenerate()
@export_range(0.5, 20.0, 0.5) var beach_blend := 4.0:
	set(value):
		beach_blend = value
		_queue_regenerate()
@export_range(5.0, 45.0, 1.0) var beach_bank_deg := 22.0:
	set(value):
		beach_bank_deg = value
		_queue_regenerate()
@export_range(2.0, 45.0, 1.0) var beach_drop_deg := 12.0:
	set(value):
		beach_drop_deg = value
		_queue_regenerate()

@export_group("Stream")
@export var spring_position := Vector2(251.0, 2.0):
	set(value):
		spring_position = value
		_queue_regenerate()
@export_range(-180.0, 180.0, 1.0) var stream_direction_deg := 95.0:
	set(value):
		stream_direction_deg = value
		_queue_regenerate()
@export_range(0.0, 1.5, 0.01) var stream_meander := 0.9:
	set(value):
		stream_meander = value
		_queue_regenerate()
@export_range(0.001, 0.2, 0.001) var stream_meander_frequency := 0.07:
	set(value):
		stream_meander_frequency = value
		_queue_regenerate()
@export_range(0.0, 2.0, 0.01) var stream_turn_penalty := 0.15:
	set(value):
		stream_turn_penalty = value
		_queue_regenerate()
@export_range(0.5, 5.0, 0.1) var stream_step := 2.0:
	set(value):
		stream_step = value
		_queue_regenerate()
@export_range(0.25, 6.0, 0.05) var stream_half_width := 0.9:
	set(value):
		stream_half_width = value
		_queue_regenerate()
@export_range(0.5, 12.0, 0.1) var stream_bank_width := 3.0:
	set(value):
		stream_bank_width = value
		_queue_regenerate()
@export_range(1.0, 40.0, 0.5) var stream_max_bank_width := 20.0:
	set(value):
		stream_max_bank_width = value
		_queue_regenerate()
@export_range(5.0, 60.0, 1.0) var stream_bank_max_slope_deg := 30.0:
	set(value):
		stream_bank_max_slope_deg = value
		_queue_regenerate()
@export_range(0.1, 4.0, 0.05) var stream_depth := 1.2:
	set(value):
		stream_depth = value
		_queue_regenerate()
@export_range(0.05, 1.5, 0.05) var stream_water_depth := 0.35:
	set(value):
		stream_water_depth = value
		_queue_regenerate()
@export_range(0.0, 1.0, 0.05) var stream_freeboard := 0.25:
	set(value):
		stream_freeboard = value
		_queue_regenerate()
@export_range(0.5, 8.0, 0.25) var stream_levee_width := 2.5:
	set(value):
		stream_levee_width = value
		_queue_regenerate()
@export_range(0.05, 1.0, 0.05) var stream_levee_slope := 0.35:
	set(value):
		stream_levee_slope = value
		_queue_regenerate()
@export_range(0.0, 0.1, 0.001) var stream_min_slope := 0.01:
	set(value):
		stream_min_slope = value
		_queue_regenerate()
@export_range(0.0, 5.0, 0.1) var stream_end_depth := 1.5:
	set(value):
		stream_end_depth = value
		_queue_regenerate()
@export_range(0.5, 12.0, 0.1) var spring_pool_radius := 4.0:
	set(value):
		spring_pool_radius = value
		_queue_regenerate()
@export_range(0.0, 3.0, 0.05) var spring_pool_depth := 0.6:
	set(value):
		spring_pool_depth = value
		_queue_regenerate()

@export_group("Lake")
@export var lake_center := Vector2(160.0, 8.0):
	set(value):
		lake_center = value
		_queue_regenerate()
@export_range(5.0, 80.0, 1.0) var lake_radius := 28.0:
	set(value):
		lake_radius = value
		_queue_regenerate()
@export_range(0.0, 30.0, 0.1) var lake_level := 6.0:
	set(value):
		lake_level = value
		_queue_regenerate()
@export_range(0.5, 10.0, 0.1) var lake_depth := 2.8:
	set(value):
		lake_depth = value
		_queue_regenerate()
@export_range(10.0, 160.0, 1.0) var valley_radius := 80.0:
	set(value):
		valley_radius = value
		_queue_regenerate()
@export_range(0.0, 40.0, 0.5) var valley_rise := 12.0:
	set(value):
		valley_rise = value
		_queue_regenerate()
@export var islet_offset := Vector2(4.0, 3.0):
	set(value):
		islet_offset = value
		_queue_regenerate()
@export_range(1.0, 20.0, 0.5) var islet_radius := 7.0:
	set(value):
		islet_radius = value
		_queue_regenerate()
@export_range(10.0, 300.0, 1.0) var waterfall_angle_deg := 250.0:
	set(value):
		waterfall_angle_deg = value
		_queue_regenerate()
@export var auto_waterfall_angle := true:
	set(value):
		auto_waterfall_angle = value
		_queue_regenerate()
@export_range(1.0, 12.0, 0.5) var waterfall_height := 5.0:
	set(value):
		waterfall_height = value
		_queue_regenerate()

@export_group("Path")
@export_range(0.5, 4.0, 0.1) var path_half_width := 1.4:
	set(value):
		path_half_width = value
		_queue_regenerate()
@export_range(0.5, 10.0, 0.25) var path_blend := 3.0:
	set(value):
		path_blend = value
		_queue_regenerate()
@export_range(0.0, 200.0, 1.0) var path_slope_cost := 25.0:
	set(value):
		path_slope_cost = value
		_queue_regenerate()

@export_group("Puddles")
## Depth of the small dips on the path, in metres. Rain fills them with puddles.
@export_range(0.0, 0.3, 0.005) var puddle_depth := 0.09:
	set(value):
		puddle_depth = value
		_queue_regenerate()
## Size of the dips: lower frequency gives larger dips.
@export_range(0.02, 0.5, 0.01) var puddle_frequency := 0.12:
	set(value):
		puddle_frequency = value
		_queue_regenerate()
## How much of the noise must be low for a dip to form. Higher gives fewer dips.
@export_range(0.0, 1.0, 0.01) var puddle_threshold := 0.55:
	set(value):
		puddle_threshold = value
		_queue_regenerate()

@export_group("Checks")
@export_range(10.0, 80.0, 1.0) var walkable_slope_deg := 40.0
@export_range(0.0, 15.0, 0.5) var plot_max_slope_deg := 5.0
@export_range(0.0, 5.0, 0.1) var border_margin := 1.0
@export_range(0.0, 1.0, 0.01) var ledge_ignore_threshold := 0.08

var heights := PackedFloat32Array()
var normals := PackedVector3Array()
var ledge_mask := PackedFloat32Array()
var stream_mask := PackedFloat32Array()
var plot_mask := PackedFloat32Array()
var beach_mask := PackedFloat32Array()

# Zone: 0 at the main island's east end (start), rising to about 0.6 at its
# west end (autumn), and 1 on the dark island. See CLAUDE.md, Zones.
var zone := PackedFloat32Array()

# Near the channel between the islands: 1 at the facing ends, where the
# coast is cliffs instead of beach.
var cliff_mask := PackedFloat32Array()

# The footpath from the village to the bridge: 1 on the path, fading at its
# edges. path_points is its centerline (x, height, z), one point per metre.
var path_mask := PackedFloat32Array()
var path_points := PackedVector3Array()

# Rock cover as the terrain shader paints it (0 vegetation ground, 1 bare
# rock): from slope and the blurred ledge mask. Scattering reads this, so
# plants never grow where the ground is drawn as rock.
var rock_cover := PackedFloat32Array()

# 1 in the lake (below its surface), fading over the shore.
var lake_mask := PackedFloat32Array()

# Stream centerline from spring to sea. X and Z are world positions,
# Y is the carved bed height at that point.
var stream_points := PackedVector3Array()

var vertex_count_side := 0
var cell_size := 1.0

var _coast_noise := FastNoiseLite.new()
var _hill_noise := FastNoiseLite.new()
var _warp_noise_x := FastNoiseLite.new()
var _warp_noise_y := FastNoiseLite.new()
var _terrace_noise := FastNoiseLite.new()
var _meander_noise := FastNoiseLite.new()
var _zone_noise := FastNoiseLite.new()
var _regenerate_queued := false
var _waterfall_angle := 0.0


func _ready() -> void:
	generate()


func generate() -> void:
	vertex_count_side = cells + 1
	cell_size = world_size / cells
	var count := vertex_count_side * vertex_count_side
	heights = _zeroed(count)
	ledge_mask = _zeroed(count)
	stream_mask = _zeroed(count)
	plot_mask = _zeroed(count)
	beach_mask = _zeroed(count)
	zone = _zeroed(count)
	cliff_mask = _zeroed(count)
	path_mask = _zeroed(count)
	lake_mask = _zeroed(count)
	_setup_noise()
	_build_base_layers()
	_dilate_ledge_mask()
	_build_beach()
	_build_landings()
	_build_lake()
	_flatten_plots()
	_build_stream_path()
	_carve_stream()
	_build_path()
	_carve_puddle_dips()
	_compute_normals()
	_finalize_ledge_mask()
	_build_mesh()
	generated.emit()


# Bilinear height lookup in world space, clamped to the grid.
func get_height(x: float, z: float) -> float:
	return sample_grid(heights, x, z)


# Bilinear lookup of any per-vertex array (heights or a mask) in world space.
func sample_grid(values: PackedFloat32Array, x: float, z: float) -> float:
	var half := world_size * 0.5
	var fx := clampf((x + half) / cell_size, 0.0, cells - 0.0001)
	var fz := clampf((z + half) / cell_size, 0.0, cells - 0.0001)
	var i := int(fx)
	var j := int(fz)
	var tx := fx - i
	var tz := fz - j
	var n := vertex_count_side
	var top := lerpf(values[j * n + i], values[j * n + i + 1], tx)
	var bottom := lerpf(values[(j + 1) * n + i], values[(j + 1) * n + i + 1], tx)
	return lerpf(top, bottom, tz)


# Surface normal at the nearest vertex.
func get_normal(x: float, z: float) -> Vector3:
	var half := world_size * 0.5
	var i := clampi(roundi((x + half) / cell_size), 0, cells)
	var j := clampi(roundi((z + half) / cell_size), 0, cells)
	return normals[j * vertex_count_side + i]


func vertex_position_2d(i: int, j: int) -> Vector2:
	var half := world_size * 0.5
	return Vector2(-half + i * cell_size, -half + j * cell_size)


func print_checks() -> bool:
	var results := TerrainChecks.run(self)
	var all_passed := true
	for result in results:
		var status := "PASS" if result.passed else "FAIL"
		print("[%s] %s: %s" % [status, result.name, result.detail])
		all_passed = all_passed and result.passed
	return all_passed


func _queue_regenerate() -> void:
	if not auto_regenerate or not is_inside_tree() or _regenerate_queued:
		return
	_regenerate_queued = true
	_run_queued_regenerate.call_deferred()


func _run_queued_regenerate() -> void:
	_regenerate_queued = false
	generate()


func _setup_noise() -> void:
	_coast_noise.seed = noise_seed
	_coast_noise.noise_type = FastNoiseLite.TYPE_SIMPLEX_SMOOTH
	_coast_noise.frequency = 1.0
	_coast_noise.fractal_type = FastNoiseLite.FRACTAL_FBM
	_coast_noise.fractal_octaves = 2

	_hill_noise.seed = noise_seed + 1
	_hill_noise.noise_type = FastNoiseLite.TYPE_SIMPLEX_SMOOTH
	_hill_noise.frequency = hill_frequency
	_hill_noise.fractal_type = FastNoiseLite.FRACTAL_FBM
	_hill_noise.fractal_octaves = hill_octaves
	_hill_noise.fractal_gain = hill_gain
	_hill_noise.fractal_lacunarity = 2.0

	for warp_noise in [_warp_noise_x, _warp_noise_y]:
		warp_noise.noise_type = FastNoiseLite.TYPE_SIMPLEX_SMOOTH
		warp_noise.frequency = warp_frequency
		warp_noise.fractal_type = FastNoiseLite.FRACTAL_NONE
	_warp_noise_x.seed = noise_seed + 2
	_warp_noise_y.seed = noise_seed + 3

	_terrace_noise.seed = noise_seed + 4
	_terrace_noise.noise_type = FastNoiseLite.TYPE_SIMPLEX_SMOOTH
	_terrace_noise.frequency = terrace_mask_frequency
	_terrace_noise.fractal_type = FastNoiseLite.FRACTAL_NONE

	_meander_noise.seed = noise_seed + 5
	_meander_noise.noise_type = FastNoiseLite.TYPE_SIMPLEX_SMOOTH
	_meander_noise.frequency = 1.0
	_meander_noise.fractal_type = FastNoiseLite.FRACTAL_NONE

	_zone_noise.seed = noise_seed + 6
	_zone_noise.noise_type = FastNoiseLite.TYPE_SIMPLEX_SMOOTH
	_zone_noise.frequency = zone_noise_frequency
	_zone_noise.fractal_type = FastNoiseLite.FRACTAL_FBM
	_zone_noise.fractal_octaves = 2


# Island falloff, central rise, headlands, warped hills and terraces in one
# pass. Hills, rise and headlands are scaled by the island mask so the coast
# and the sea floor stay clean.
func _build_base_layers() -> void:
	var n := vertex_count_side
	for j in n:
		for i in n:
			var idx := j * n + i
			var p := vertex_position_2d(i, j)
			var main := _island_shape(p, main_center, island_radius, island_aspect, -1.0)
			var dark := _island_shape(p, dark_center, dark_radius, dark_aspect, 1.0)
			var shape := main if main.x >= dark.x else dark
			var island := shape.x
			var warp := Vector2(_warp_noise_x.get_noise_2dv(p), _warp_noise_y.get_noise_2dv(p)) * warp_amplitude
			var hills := _hill_noise.get_noise_2dv(p + warp) * hill_height
			var rise := center_rise * (1.0 - smoothstep(0.0, 1.0, shape.y))
			var headland := headland_height * smoothstep(0.0, 0.85, shape.z)
			var h := lerpf(-sea_depth, land_height, island) + (rise + headland + hills) * island
			cliff_mask[idx] = channel_cliff(p)
			heights[idx] = _apply_terrace(h, p, idx, island)
			ledge_mask[idx] = maxf(ledge_mask[idx], cliff_mask[idx] * smoothstep(0.05, 0.4, island))
			zone[idx] = get_zone(p.x, p.y)


# One island: returns (mask, normalized distance from its centre, position
# along the axis towards the channel from -1 to 1). The radius is perturbed
# by noise sampled on a circle so the coastline gets gentle lobes; facing
# the channel the coastal falloff is much shorter, which makes cliffs.
# facing is -1 for an island whose channel side is towards -x.
func _island_shape(p: Vector2, center: Vector2, radius: float, aspect: float, facing: float) -> Vector3:
	var q := Vector2((p.x - center.x) / aspect, p.y - center.y)
	var angle := atan2(q.y, q.x)
	var seed_offset := center.x * 0.013
	var lobes := _coast_noise.get_noise_2d(cos(angle) * coast_noise_scale + seed_offset, sin(angle) * coast_noise_scale)
	var r := radius * (1.0 + coast_noise_amount * lobes)
	var toward := facing * cos(angle)
	var width := lerpf(coast_width, cliff_coast_width, smoothstep(0.4, 0.85, toward))
	var mask := 1.0 - smoothstep(r - width, r, q.length())
	return Vector3(mask, q.length() / radius, facing * q.x / radius)


func _island_mask(p: Vector2) -> float:
	var main := _island_shape(p, main_center, island_radius, island_aspect, -1.0)
	var dark := _island_shape(p, dark_center, dark_radius, dark_aspect, 1.0)
	return maxf(main.x, dark.x)


# x of the middle of the channel between the islands' facing ends.
func channel_x() -> float:
	var main_end := main_center.x - island_radius * island_aspect
	var dark_end := dark_center.x + dark_radius * dark_aspect
	return (main_end + dark_end) * 0.5


# 1 at the channel, fading over a few tens of metres up the facing ends.
func channel_cliff(p: Vector2) -> float:
	var half_gap := absf(main_center.x - island_radius * island_aspect - channel_x())
	var d := Vector2(p.x - channel_x(), p.y * 0.8).length() - half_gap
	return 1.0 - smoothstep(20.0, 55.0, d)


# The lake valley in the middle of the main island: a wide bowl lowers the
# hills towards a flat valley floor around the lake (only lowering), the
# lake basin is carved below the lake level with a noise-perturbed shore,
# an islet rises in the lake, and on one side of the valley a rock step
# stands above the shore for the waterfall to drop from. The lake shore is
# recorded in beach_mask (sand) and lake_mask.
func _build_lake() -> void:
	var n := vertex_count_side
	var floor_height := lake_level + 0.6
	_waterfall_angle = _pick_waterfall_angle() if auto_waterfall_angle else deg_to_rad(waterfall_angle_deg)
	var fall_dir := Vector2.from_angle(_waterfall_angle)
	var fall_point := waterfall_base()
	var islet := lake_center + islet_offset
	var reach := valley_radius + 4.0
	var top := lake_level + waterfall_height
	var bounds := _index_bounds(lake_center - Vector2(reach, reach), lake_center + Vector2(reach, reach))
	for j in range(bounds[1], bounds[3] + 1):
		for i in range(bounds[0], bounds[2] + 1):
			var idx := j * n + i
			var p := vertex_position_2d(i, j)
			var offset := p - lake_center
			var d := offset.length()
			if d > reach:
				continue
			var r := _lake_shore_radius(atan2(offset.y, offset.x))
			var h := heights[idx]

			# Valley bowl: the ground may not rise above this profile.
			var bowl := floor_height + valley_rise * smoothstep(r + 4.0, valley_radius, d)
			h = _smooth_min(h, bowl, 1.5)
			# Rim: around the lake the ground may not drop below the water, so
			# the lake never spills over low ground.
			if d > r + 0.5:
				var rim := lake_level + 0.35 + minf(d - r - 0.5, 10.0) * 0.06
				h = maxf(h, lerpf(rim, h, smoothstep(r + 8.0, r + 26.0, d)))

			# Lake basin and shore.
			var basin := lake_level - lake_depth * (1.0 - pow(minf(d / r, 1.0), 2.0)) - 0.25
			var shore := smoothstep(r - 1.0, r + 4.0, d)
			h = lerpf(basin, h, shore) if d < r + 4.0 else h
			lake_mask[idx] = 1.0 - smoothstep(r - 1.5, r + 0.5, d)
			beach_mask[idx] = maxf(beach_mask[idx], 1.0 - smoothstep(r + 1.0, r + 5.0, d))

			# The islet's shore slopes gently into the lake bed.
			var di := p.distance_to(islet)
			if di < islet_radius + 12.0:
				var mound := lake_level + 1.0 - maxf(di - islet_radius * 0.75, 0.0) * 0.4
				mound += 0.4 * (1.0 - smoothstep(0.0, islet_radius * 0.75, di))
				h = maxf(h, mound)
				lake_mask[idx] *= smoothstep(islet_radius - 0.5, islet_radius + 1.5, di)
				beach_mask[idx] *= smoothstep(islet_radius * 0.85, islet_radius * 1.15, di)

			# Waterfall: a vertical rock face at the shore with a plateau behind
			# it that runs back into the (high) valley wall. Face and sides are
			# cliff rock.
			var df := p - fall_point
			var along := df.dot(fall_dir)
			var across := absf(df.dot(fall_dir.orthogonal()))
			if along > -3.0 and along < 30.0 and across < 12.0:
				var width := 5.5
				var plateau := top - maxf(along - 8.0, 0.0) * 0.15
				var face := smoothstep(-0.4, 0.4, along)
				var sides := 1.0 - smoothstep(width, width + 1.5, across)
				var shelf := lerpf(h, maxf(h, plateau), face * sides)
				var cliff := maxf((1.0 - smoothstep(0.4, 2.0, along)) * sides, smoothstep(width - 1.0, width + 0.5, across) * (1.0 - smoothstep(width + 1.5, width + 4.0, across)))
				cliff *= 1.0 - smoothstep(24.0, 30.0, along)
				ledge_mask[idx] = maxf(ledge_mask[idx], cliff)
				beach_mask[idx] *= 1.0 - smoothstep(0.0, 0.5, cliff)
				h = shelf
			heights[idx] = h


# Shore radius of the lake in a direction, perturbed by noise.
func _lake_shore_radius(angle: float) -> float:
	var wobble := _coast_noise.get_noise_2d(cos(angle) * 2.2 + 7.0, sin(angle) * 2.2) * 0.18
	return lake_radius * (1.0 + wobble)


# The waterfall goes where the ground around the lake is highest, so its
# plateau runs back into the valley wall instead of standing free.
func _pick_waterfall_angle() -> float:
	var best := 0.0
	var best_height := -INF
	for k in 72:
		var angle := TAU * k / 72.0
		var probe := lake_center + Vector2.from_angle(angle) * (lake_radius + 22.0)
		var h := get_height(probe.x, probe.y)
		if h > best_height:
			best_height = h
			best = angle
	return best


# Water surface height at a world position: the lake level inside the lake,
# else sea level.
func water_level(x: float, z: float) -> float:
	if lake_mask.is_empty():
		return SEA_LEVEL
	return lake_level if sample_grid(lake_mask, x, z) > 0.3 else SEA_LEVEL


# Where the waterfall drops into the lake (x, z) and its direction outwards.
func waterfall_base() -> Vector2:
	return lake_center + Vector2.from_angle(_waterfall_angle) * (_lake_shore_radius(_waterfall_angle) + 0.5)


func waterfall_direction() -> Vector2:
	return Vector2.from_angle(_waterfall_angle)


# Bridge abutments: a flat landing at deck height on each headland. Inland
# of it a ramp runs down along the bridge axis at a gentle slope, with
# steeper but still walkable shoulders at its sides, so the landing is
# reachable without raising the headland's flanks into new cliffs. Applied
# after terraces and beach so neither can step or lower it.
func _build_landings() -> void:
	var n := vertex_count_side
	var along_slope := tan(deg_to_rad(LANDING_RAMP_DEG))
	var side_slope := tan(deg_to_rad(LANDING_SHOULDER_DEG))
	var deck := bridge_deck_height - 0.05
	for idx in heights.size():
		var p := vertex_position_2d(idx % n, idx / n)
		var from_end := absf(p.x - channel_x()) - BRIDGE_HALF_SPAN
		if from_end < -LANDING_OVERLAP:
			continue
		var along := maxf(from_end - LANDING_LENGTH, 0.0)
		var across := maxf(absf(p.y) - LANDING_HALF_WIDTH, 0.0)
		# Beside the bridge end, towards the channel, the cliffs stay as they
		# are; only the plateau itself reaches out there.
		if from_end < 2.0 and across > 0.0:
			# The abutment's side walls are cliff rock.
			if across < 3.0:
				ledge_mask[idx] = 1.0
			continue
		var target := deck - along * along_slope - across * side_slope
		if target <= heights[idx] - 0.01 and (along > 0.0 or across > 0.0):
			continue
		if along == 0.0 and across == 0.0:
			heights[idx] = deck
		else:
			# Fade the raise out towards the coast so no new cliffs appear there.
			var inland := smoothstep(0.85, 1.0, _island_mask(p))
			heights[idx] = lerpf(heights[idx], target, inland)
		# The channel-side edge of the landing stays a cliff (ledge).
		# Plateau edges towards the channel and beside the bridge end stay
		# cliff rock; the plateau interior and the ramp inland are cleared.
		var interior := from_end > -LANDING_OVERLAP + 2.0 and absf(p.y) < LANDING_HALF_WIDTH - 1.5
		if from_end < 8.0 and absf(p.y) > LANDING_HALF_WIDTH - 1.5 and across < 3.0:
			ledge_mask[idx] = 1.0
		elif from_end >= 2.0 or interior:
			ledge_mask[idx] *= smoothstep(0.0, 6.0, Vector2(along, across).length())


# Distance in metres from a point to the nearest landing plateau, 0 on it,
# or -1 on the channel side of the bridge ends (where the cliffs are).
func _landing_distance(p: Vector2) -> float:
	var from_end := absf(p.x - channel_x()) - BRIDGE_HALF_SPAN
	if from_end < -LANDING_OVERLAP:
		return -1.0
	var along := from_end - clampf(from_end, -LANDING_OVERLAP, LANDING_LENGTH)
	var across := absf(p.y) - LANDING_HALF_WIDTH
	return Vector2(maxf(along, 0.0), maxf(across, 0.0)).length()


# 1 on the bridge's landing plateaus, fading over a few metres (used to keep
# trees and dressing off them).
func bridge_landing(p: Vector2) -> float:
	var d := _landing_distance(p)
	if d < 0.0:
		return 0.0
	return 1.0 - smoothstep(1.0, 5.0, d)


# Zone value at a world position, see the zone array.
func get_zone(x: float, z: float) -> float:
	var noise_value := _zone_noise.get_noise_2d(x, z) * zone_noise_amount
	if x < channel_x():
		return 1.0
	var half_length := island_radius * island_aspect
	var t := (main_center.x + half_length - x) / (2.0 * half_length)
	return clampf(t * MAIN_ZONE_SPAN + noise_value, 0.0, MAIN_ZONE_SPAN + 0.05)


# Soft terrace: flat plateaus with a short ramp at the end of each step.
# A low-frequency noise mask decides where terraces appear. They fade out on
# the coastal falloff so the island edge does not turn into contour rings.
# The whole ramp is recorded as a ledge candidate, see _finalize_ledge_mask.
func _apply_terrace(h: float, p: Vector2, idx: int, island: float) -> float:
	var mask_value := _terrace_noise.get_noise_2dv(p)
	var weight := smoothstep(terrace_mask_threshold - 0.1, terrace_mask_threshold + 0.1, mask_value)
	weight *= smoothstep(terrace_inland - 0.1, terrace_inland, island) * terrace_strength
	# No terraces around the bridge landings: the approach stays smooth.
	var to_landing := _landing_distance(p)
	if to_landing >= 0.0:
		weight *= smoothstep(25.0, 50.0, to_landing)
	if weight <= 0.0:
		return h
	var t := h / terrace_step
	var level := floorf(t)
	var ramp_linear := clampf((t - level - (1.0 - terrace_edge)) / terrace_edge, 0.0, 1.0)
	var ramp := smoothstep(0.0, 1.0, ramp_linear)
	ledge_mask[idx] = weight * minf(8.0 * ramp_linear * (1.0 - ramp_linear), 1.0)
	return lerpf(h, (level + ramp) * terrace_step, weight)


# Grows the ledge mask by one vertex. Narrow ramps on steep ground can be a
# single cell wide, and the vertices on their rim are steep but unmasked.
func _dilate_ledge_mask() -> void:
	var n := vertex_count_side
	var source := ledge_mask.duplicate()
	for j in range(1, n - 1):
		for i in range(1, n - 1):
			var idx := j * n + i
			ledge_mask[idx] = maxf(source[idx], maxf(maxf(source[idx - 1], source[idx + 1]), maxf(source[idx - n], source[idx + n])))


# A beach shelf, as left by the sea over a long time. Positions come from a
# signed distance to the coastline (positive on land). The raw distance
# follows the grid like a staircase, so it is blurred, and the beach profile
# then defines the waterline as a smooth curve.
# The profile: a small lip on each side of the waterline (so the ground does
# not lie almost in the water plane), a nearly flat strip rising to
# beach_rise over beach_width metres, then a bank rising at beach_bank_deg.
# Offshore a shallow shelf sloping to beach_offshore_depth, then a drop at
# beach_drop_deg.
# Facing the channel (cliff mask) there is no beach.
# On land the terrain is only ever lowered to the profile, so only the coastal
# slope is cut and the bank stays walkable. On the shelf the ground follows
# the profile exactly, and beyond it the sea floor is only ever raised.
# A smooth min/max avoids creases where the profile meets the terrain.
func _build_beach() -> void:
	var land_distance := _distance_field(true)
	var sea_distance := _distance_field(false)
	var signed := PackedFloat32Array()
	signed.resize(heights.size())
	for idx in heights.size():
		if heights[idx] > SEA_LEVEL:
			signed[idx] = land_distance[idx] - cell_size * 0.5
		else:
			signed[idx] = -(sea_distance[idx] - cell_size * 0.5)
	signed = _blur(signed, 3, 3)

	var width := maxf(beach_width, 0.01)
	var offshore := maxf(beach_offshore, 0.01)
	for idx in heights.size():
		var sd := signed[idx]
		var profile := _beach_profile(sd, width, offshore)
		var original := heights[idx]
		if sd >= 0.0:
			heights[idx] = _smooth_min(maxf(heights[idx], SEA_LEVEL + BEACH_LIP), profile, BEACH_SMOOTHING)
			beach_mask[idx] = 1.0 - smoothstep(width * 0.8, width + beach_blend, sd)
		else:
			var w := smoothstep(offshore, offshore + beach_blend, -sd)
			var filled := -_smooth_min(-heights[idx], -profile, BEACH_SMOOTHING)
			heights[idx] = lerpf(profile, filled, w)
			beach_mask[idx] = 1.0 - w
		# No beach at the channel: the islands meet the sea in cliffs there.
		heights[idx] = lerpf(heights[idx], original, cliff_mask[idx])
		beach_mask[idx] *= 1.0 - cliff_mask[idx]


func _beach_profile(sd: float, width: float, offshore: float) -> float:
	if sd >= 0.0:
		return SEA_LEVEL + BEACH_LIP * smoothstep(0.0, 2.0, sd) + beach_rise * minf(sd / width, 1.0) \
			+ maxf(sd - width, 0.0) * tan(deg_to_rad(beach_bank_deg))
	var d := -sd
	return SEA_LEVEL - BEACH_LIP * smoothstep(0.0, 2.0, d) - beach_offshore_depth * minf(d / offshore, 1.0) \
		- maxf(d - offshore, 0.0) * tan(deg_to_rad(beach_drop_deg))


# Separable box blur over the grid, repeated for a smoother, gaussian-like
# result. Edges are clamped.
func _blur(source: PackedFloat32Array, radius: int, passes: int) -> PackedFloat32Array:
	var n := vertex_count_side
	var result := source.duplicate()
	var temp := PackedFloat32Array()
	temp.resize(result.size())
	var taps := float(radius * 2 + 1)
	for pass_index in passes:
		for j in n:
			for i in n:
				var total := 0.0
				for k in range(-radius, radius + 1):
					total += result[j * n + clampi(i + k, 0, n - 1)]
				temp[j * n + i] = total / taps
		for j in n:
			for i in n:
				var total := 0.0
				for k in range(-radius, radius + 1):
					total += temp[clampi(j + k, 0, n - 1) * n + i]
				result[j * n + i] = total / taps
	return result


# Polynomial smooth minimum: like minf but rounded over a band of width k.
func _smooth_min(a: float, b: float, k: float) -> float:
	var h := clampf(0.5 + 0.5 * (b - a) / k, 0.0, 1.0)
	return lerpf(b, a, h) - k * h * (1.0 - h)


# Approximate euclidean distance in metres from every vertex to the nearest
# vertex on the other side of the waterline, for land vertices (from_land)
# or sea vertices. Two-pass chamfer transform with 8 neighbours.
func _distance_field(from_land: bool) -> PackedFloat32Array:
	var n := vertex_count_side
	var distance := PackedFloat32Array()
	distance.resize(heights.size())
	for idx in heights.size():
		var is_land := heights[idx] > SEA_LEVEL
		distance[idx] = INF if is_land == from_land else 0.0
	var straight := cell_size
	var diagonal := cell_size * sqrt(2.0)
	for j in n:
		for i in n:
			var idx := j * n + i
			var d := distance[idx]
			if i > 0:
				d = minf(d, distance[idx - 1] + straight)
			if j > 0:
				d = minf(d, distance[idx - n] + straight)
				if i > 0:
					d = minf(d, distance[idx - n - 1] + diagonal)
				if i < n - 1:
					d = minf(d, distance[idx - n + 1] + diagonal)
			distance[idx] = d
	for j in range(n - 1, -1, -1):
		for i in range(n - 1, -1, -1):
			var idx := j * n + i
			var d := distance[idx]
			if i < n - 1:
				d = minf(d, distance[idx + 1] + straight)
			if j < n - 1:
				d = minf(d, distance[idx + n] + straight)
				if i < n - 1:
					d = minf(d, distance[idx + n + 1] + diagonal)
				if i > 0:
					d = minf(d, distance[idx + n - 1] + diagonal)
			distance[idx] = d
	return distance


# Each plot is (x, z, radius). Plots are flattened to the height at their
# center and blended into the surrounding terrain. Like the stream banks, the
# blend widens with the height difference so it stays walkable.
# All plots are blended in one pass. Each plot gets an influence of 1 inside
# and 0 beyond its blend, and the weight influence / (1 - influence) lets the
# plot a vertex stands inside dominate any neighbour's blend zone.
func _flatten_plots() -> void:
	var n := vertex_count_side
	var targets := PackedFloat32Array()
	for plot in house_plots:
		targets.append(get_height(plot.x, plot.y))
	var original := heights.duplicate()
	for j in n:
		for i in n:
			var idx := j * n + i
			var p := vertex_position_2d(i, j)
			var total_weight := 0.0
			var weighted_target := 0.0
			var strongest := 0.0
			for k in house_plots.size():
				var plot := house_plots[k]
				var d := p.distance_to(Vector2(plot.x, plot.y))
				if d >= plot.z + plot_max_blend:
					continue
				var needed := absf(original[idx] - targets[k]) * 1.5 / tan(deg_to_rad(plot_blend_max_slope_deg))
				var blend := clampf(needed, plot_blend, plot_max_blend)
				var influence := 1.0 - smoothstep(plot.z, plot.z + blend, d)
				if influence <= 0.0:
					continue
				var weight := influence / maxf(1.0 - influence, 0.0001)
				total_weight += weight
				weighted_target += weight * targets[k]
				strongest = maxf(strongest, influence)
			if total_weight <= 0.0:
				continue
			heights[idx] = lerpf(original[idx], weighted_target / total_weight, strongest)
			plot_mask[idx] = strongest


# Walks from the spring in the main direction until the path is well out in
# the sea. Each step starts from a noise-driven meander heading, then probes a
# fan of nearby headings and prefers the lowest ground ahead, so the stream
# follows valleys instead of cutting through hills. Turning costs a penalty in
# metres per probe angle, and the heading is smoothed between steps.
# The bed profile is the terrain height minus the stream depth, forced to drop
# by at least the minimum slope every step so it decreases monotonically.
func _build_stream_path() -> void:
	stream_points.clear()
	var path := PackedVector2Array([spring_position])
	var p := spring_position
	var base_angle := deg_to_rad(stream_direction_deg)
	var probe_angle := deg_to_rad(15.0)
	var limit := world_size * 0.5 - stream_step
	var heading := base_angle
	var travelled := 0.0
	for step_index in 2000:
		var desired := base_angle + stream_meander * _meander_noise.get_noise_1d(travelled * stream_meander_frequency)
		var best_angle := desired
		var best_score := INF
		for k in range(-3, 4):
			var candidate := desired + k * probe_angle
			var probe := p + Vector2(cos(candidate), sin(candidate)) * stream_step * 3.0
			var score := get_height(probe.x, probe.y) + stream_turn_penalty * absi(k)
			if score < best_score:
				best_score = score
				best_angle = candidate
		heading = lerp_angle(heading, best_angle, 0.5)
		p += Vector2(cos(heading), sin(heading)) * stream_step
		travelled += stream_step
		path.append(p)
		if get_height(p.x, p.y) < SEA_LEVEL - stream_end_depth:
			break
		if absf(p.x) > limit or absf(p.y) > limit:
			break

	var previous_bed := INF
	for point in path:
		var bed := minf(get_height(point.x, point.y) - stream_depth, previous_bed - stream_min_slope * stream_step)
		stream_points.append(Vector3(point.x, bed, point.y))
		previous_bed = bed


# Finds the closest stream segment for every vertex near the path, then lowers
# the terrain towards the bed, with levees where a bank would be lower than
# the water. The spring gets a small round pool below the first bed point;
# its levee is left open where the stream leaves the pool.
func _carve_stream() -> void:
	if stream_points.size() < 2:
		return
	var n := vertex_count_side
	var count := heights.size()
	var reach := stream_half_width + stream_max_bank_width
	var best_distance := PackedFloat32Array()
	best_distance.resize(count)
	best_distance.fill(INF)
	var best_bed := PackedFloat32Array()
	best_bed.resize(count)

	for k in stream_points.size() - 1:
		var a := Vector2(stream_points[k].x, stream_points[k].z)
		var b := Vector2(stream_points[k + 1].x, stream_points[k + 1].z)
		var ab := b - a
		var length_sq := maxf(ab.length_squared(), 0.0001)
		var low := Vector2(minf(a.x, b.x), minf(a.y, b.y)) - Vector2(reach, reach)
		var high := Vector2(maxf(a.x, b.x), maxf(a.y, b.y)) + Vector2(reach, reach)
		var bounds := _index_bounds(low, high)
		for j in range(bounds[1], bounds[3] + 1):
			for i in range(bounds[0], bounds[2] + 1):
				var idx := j * n + i
				var p := vertex_position_2d(i, j)
				var t := clampf((p - a).dot(ab) / length_sq, 0.0, 1.0)
				var d := p.distance_to(a + ab * t)
				if d < best_distance[idx]:
					best_distance[idx] = d
					best_bed[idx] = lerpf(stream_points[k].y, stream_points[k + 1].y, t)

	for idx in count:
		if best_distance[idx] < reach:
			_carve_vertex(idx, best_distance[idx], stream_half_width, best_bed[idx], best_bed[idx] + stream_water_depth)

	var spring := Vector2(stream_points[0].x, stream_points[0].z)
	var pool_reach := spring_pool_radius + stream_max_bank_width
	var bounds := _index_bounds(spring - Vector2(pool_reach, pool_reach), spring + Vector2(pool_reach, pool_reach))
	for j in range(bounds[1], bounds[3] + 1):
		for i in range(bounds[0], bounds[2] + 1):
			var d := vertex_position_2d(i, j).distance_to(spring)
			if d >= pool_reach:
				continue
			var bowl := 1.0 - pow(minf(d / spring_pool_radius, 1.0), 2.0)
			var bed := stream_points[0].y - spring_pool_depth * bowl
			var idx := j * n + i
			var level := stream_points[0].y + stream_water_depth
			if best_distance[idx] < stream_half_width + stream_levee_width:
				level = -INF
			_carve_vertex(idx, d, spring_pool_radius, bed, level)


# Shapes one vertex of the channel. Inside the inner distance the terrain
# sits at the bed, outside it a smooth bank rises to the original terrain;
# the bank widens with the depth of the cut so it never gets steeper than
# the configured bank slope (smoothstep peaks at 1.5 times its average).
# Where the channel runs along a slope, the downhill bank can be lower than
# the water. There a natural levee is built up: it rises from the bed to the
# water level plus some freeboard over the levee width, then falls off
# outwards at the levee slope. The levee only ever raises the terrain.
func _carve_vertex(idx: int, d: float, inner: float, bed: float, level: float) -> void:
	var cut := heights[idx] - bed
	if cut > 0.0:
		var needed := cut * 1.5 / tan(deg_to_rad(stream_bank_max_slope_deg))
		var bank := clampf(needed, stream_bank_width, stream_max_bank_width)
		if d < inner + bank:
			var w := smoothstep(inner, inner + bank, d)
			heights[idx] = lerpf(bed, heights[idx], w)
			stream_mask[idx] = maxf(stream_mask[idx], 1.0 - w)
	if d <= inner:
		return
	var crest := level + stream_freeboard
	var rise := smoothstep(inner, inner + stream_levee_width, d)
	var outward := maxf(d - inner - stream_levee_width, 0.0) * stream_levee_slope
	var levee := minf(lerpf(bed, crest, rise), crest - outward)
	if heights[idx] < levee:
		heights[idx] = levee
		stream_mask[idx] = maxf(stream_mask[idx], 1.0 - rise)


# The footpath: a least-cost route from the middle of the village to the
# bridge landing on the main island, found with A* on a coarse grid. Steep
# ground costs a lot, steps steeper than PATH_MAX_GRADE (ledges, cliffs) and
# water, beach and the stream are blocked, so
# the path finds the gentle way through the hills. The route is smoothed,
# resampled every metre, and its heights are smoothed along the way; then
# the ground is shaped to it: flat across the path, blended into the
# surrounding terrain at the sides.
func _build_path() -> void:
	path_points.clear()
	if house_plots.is_empty():
		return
	var village := Vector2.ZERO
	for plot in house_plots:
		village += Vector2(plot.x, plot.y)
	village /= house_plots.size()
	var landing := Vector2(channel_x() + BRIDGE_HALF_SPAN + 2.0, 0.0)
	var route := _find_route(village, landing)
	if route.size() < 2:
		return
	for k in 3:
		route = _chaikin(route)
	var dense := _resample(route, 1.0)
	var raw := PackedFloat32Array()
	for p in dense:
		raw.append(get_height(p.x, p.y))
	# The smoothing window shrinks towards the ends, so the path meets the
	# village and the bridge landing at their real height.
	for k in dense.size():
		var total := 0.0
		var weight := 0.0
		var window := mini(6, mini(k, dense.size() - 1 - k))
		for o in range(-window, window + 1):
			var m := clampi(k + o, 0, dense.size() - 1)
			total += raw[m]
			weight += 1.0
		path_points.append(Vector3(dense[k].x, total / weight, dense[k].y))
	_shape_path()


# A* over a coarse grid (PATH_CELL metres). Cost per step is its length times
# 1 + slope cost * grade squared; blocked cells cost INF.
func _find_route(from: Vector2, to: Vector2) -> PackedVector2Array:
	var size := int(world_size / PATH_CELL)
	var half := world_size * 0.5
	var start := Vector2i(int((from.x + half) / PATH_CELL), int((from.y + half) / PATH_CELL))
	var goal := Vector2i(int((to.x + half) / PATH_CELL), int((to.y + half) / PATH_CELL))
	var height := PackedFloat32Array()
	var blocked := PackedByteArray()
	height.resize(size * size)
	blocked.resize(size * size)
	for j in size:
		for i in size:
			var p := Vector2(-half + (i + 0.5) * PATH_CELL, -half + (j + 0.5) * PATH_CELL)
			var k := j * size + i
			height[k] = get_height(p.x, p.y)
			var bad := height[k] < water_level(p.x, p.y) + 1.0 \
				or sample_grid(lake_mask, p.x, p.y) > 0.05 \
				or sample_grid(stream_mask, p.x, p.y) > 0.05 \
				or sample_grid(beach_mask, p.x, p.y) > 0.4
			blocked[k] = 1 if bad and Vector2i(i, j) != start and Vector2i(i, j) != goal else 0

	var cost := PackedFloat32Array()
	cost.resize(size * size)
	cost.fill(INF)
	var came := PackedInt32Array()
	came.resize(size * size)
	came.fill(-1)
	var heap: Array[Vector2] = []
	var start_k := start.y * size + start.x
	var goal_k := goal.y * size + goal.x
	cost[start_k] = 0.0
	_heap_push(heap, Vector2(0.0, start_k))
	var steps := [Vector2i(1, 0), Vector2i(-1, 0), Vector2i(0, 1), Vector2i(0, -1),
		Vector2i(1, 1), Vector2i(1, -1), Vector2i(-1, 1), Vector2i(-1, -1)]
	while not heap.is_empty():
		var current := int(_heap_pop(heap).y)
		if current == goal_k:
			break
		var ci := current % size
		var cj := current / size
		for step in steps:
			var ni: int = ci + step.x
			var nj: int = cj + step.y
			if ni < 0 or nj < 0 or ni >= size or nj >= size:
				continue
			var nk := nj * size + ni
			if blocked[nk] == 1:
				continue
			var run := PATH_CELL * (1.4142 if step.x != 0 and step.y != 0 else 1.0)
			var grade := (height[nk] - height[current]) / run
			if absf(grade) > PATH_MAX_GRADE:
				continue
			var next_cost := cost[current] + run * (1.0 + path_slope_cost * grade * grade)
			if next_cost < cost[nk]:
				cost[nk] = next_cost
				came[nk] = current
				var guess := Vector2(goal.x - ni, goal.y - nj).length() * PATH_CELL
				_heap_push(heap, Vector2(next_cost + guess, nk))
	var route := PackedVector2Array()
	if came[goal_k] == -1:
		return route
	var k := goal_k
	while k != -1:
		route.append(Vector2(-half + (k % size + 0.5) * PATH_CELL, -half + (k / size + 0.5) * PATH_CELL))
		k = came[k]
	route.reverse()
	route[0] = from
	route[route.size() - 1] = to
	return route


# Binary min-heap of (priority, index) pairs.
func _heap_push(heap: Array[Vector2], item: Vector2) -> void:
	heap.append(item)
	var k := heap.size() - 1
	while k > 0:
		var parent := (k - 1) / 2
		if heap[parent].x <= heap[k].x:
			break
		var swap := heap[parent]
		heap[parent] = heap[k]
		heap[k] = swap
		k = parent


func _heap_pop(heap: Array[Vector2]) -> Vector2:
	var top := heap[0]
	var last: Vector2 = heap.pop_back()
	if heap.is_empty():
		return top
	heap[0] = last
	var k := 0
	while true:
		var left := k * 2 + 1
		var right := left + 1
		var smallest := k
		if left < heap.size() and heap[left].x < heap[smallest].x:
			smallest = left
		if right < heap.size() and heap[right].x < heap[smallest].x:
			smallest = right
		if smallest == k:
			break
		var swap := heap[smallest]
		heap[smallest] = heap[k]
		heap[k] = swap
		k = smallest
	return top


# Chaikin corner cutting: rounds the grid route into gentle curves.
func _chaikin(points: PackedVector2Array) -> PackedVector2Array:
	var result := PackedVector2Array([points[0]])
	for k in points.size() - 1:
		result.append(points[k].lerp(points[k + 1], 0.25))
		result.append(points[k].lerp(points[k + 1], 0.75))
	result.append(points[points.size() - 1])
	return result


func _resample(points: PackedVector2Array, spacing: float) -> PackedVector2Array:
	var result := PackedVector2Array([points[0]])
	var carry := 0.0
	for k in points.size() - 1:
		var a := points[k]
		var b := points[k + 1]
		var length := a.distance_to(b)
		var t := spacing - carry
		while t <= length:
			result.append(a.lerp(b, t / length))
			t += spacing
		carry = length - (t - spacing)
	result.append(points[points.size() - 1])
	return result


# Shapes the ground along the path: flat at the path height across its
# width, blended back into the terrain beyond it.
func _shape_path() -> void:
	var n := vertex_count_side
	var reach := path_half_width + PATH_MAX_BLEND
	var bank_factor := 1.5 / tan(deg_to_rad(stream_bank_max_slope_deg))
	var best_distance := PackedFloat32Array()
	best_distance.resize(heights.size())
	best_distance.fill(INF)
	var best_height := PackedFloat32Array()
	best_height.resize(heights.size())
	for k in path_points.size() - 1:
		var a := Vector2(path_points[k].x, path_points[k].z)
		var b := Vector2(path_points[k + 1].x, path_points[k + 1].z)
		var ab := b - a
		var length_sq := maxf(ab.length_squared(), 0.0001)
		var low := Vector2(minf(a.x, b.x), minf(a.y, b.y)) - Vector2(reach, reach)
		var high := Vector2(maxf(a.x, b.x), maxf(a.y, b.y)) + Vector2(reach, reach)
		var bounds := _index_bounds(low, high)
		for j in range(bounds[1], bounds[3] + 1):
			for i in range(bounds[0], bounds[2] + 1):
				var idx := j * n + i
				var p := vertex_position_2d(i, j)
				var t := clampf((p - a).dot(ab) / length_sq, 0.0, 1.0)
				var d := p.distance_to(a + ab * t)
				if d < best_distance[idx]:
					best_distance[idx] = d
					best_height[idx] = lerpf(path_points[k].y, path_points[k + 1].y, t)
	for idx in heights.size():
		var d := best_distance[idx]
		if d >= reach:
			continue
		# The blend widens with the height difference, like the stream banks,
		# so cuts and fills beside the path stay walkable.
		var blend := clampf(absf(heights[idx] - best_height[idx]) * bank_factor, path_blend, PATH_MAX_BLEND)
		if d >= path_half_width + blend:
			continue
		var w := smoothstep(path_half_width, path_half_width + blend, d)
		heights[idx] = lerpf(best_height[idx], heights[idx], w)
		path_mask[idx] = 1.0 - smoothstep(path_half_width * 0.6, path_half_width + 0.8, d)
		ledge_mask[idx] *= 1.0 - path_mask[idx]


# Small dips on the path, where a low-frequency noise is low. Rain fills them,
# and the splash mask finds them from the heights. Only the path is dipped,
# so the wider ground stays as it was.
func _carve_puddle_dips() -> void:
	var noise := FastNoiseLite.new()
	noise.seed = noise_seed + 11
	noise.noise_type = FastNoiseLite.TYPE_SIMPLEX_SMOOTH
	noise.frequency = puddle_frequency
	noise.fractal_octaves = 2
	var n := vertex_count_side
	for j in n:
		for i in n:
			var idx := j * n + i
			if path_mask[idx] < 0.5:
				continue
			var p := vertex_position_2d(i, j)
			var value := noise.get_noise_2d(p.x, p.y) * 0.5 + 0.5
			var dip := smoothstep(puddle_threshold, puddle_threshold + 0.25, 1.0 - value)
			heights[idx] -= dip * puddle_depth * path_mask[idx]


# Smooth normals from central differences on the heightmap.
func _compute_normals() -> void:
	var n := vertex_count_side
	normals.resize(heights.size())
	for j in n:
		for i in n:
			var i0 := maxi(i - 1, 0)
			var i1 := mini(i + 1, n - 1)
			var j0 := maxi(j - 1, 0)
			var j1 := mini(j + 1, n - 1)
			var dx := (heights[j * n + i1] - heights[j * n + i0]) / ((i1 - i0) * cell_size)
			var dz := (heights[j1 * n + i] - heights[j0 * n + i]) / ((j1 - j0) * cell_size)
			normals[j * n + i] = Vector3(-dx, 1.0, -dz).normalized()


# A ledge is a terrace ramp that is still steep after plots and the stream
# have reshaped the terrain. Where they flattened a ramp the mask fades out.
func _finalize_ledge_mask() -> void:
	var gentle := cos(deg_to_rad(ledge_min_slope_deg))
	var steep := cos(deg_to_rad(ledge_min_slope_deg + 10.0))
	for idx in ledge_mask.size():
		ledge_mask[idx] *= smoothstep(gentle, steep, normals[idx].y)


# Regular grid mesh. Each cell is split along the diagonal whose end points
# have the smaller height difference, so ridges and valleys follow the
# triangle edges. A small bias keeps flat areas on one consistent diagonal
# instead of zigzagging. Vertex colors carry the masks to the shader:
# red = ledge, green = stream, blue = house plot, alpha = beach.
# The ledge channel is a blurred copy of the ledge mask, so the rock blends
# into the grass over a few metres instead of a single grid cell.
# UV.x carries the zone value, UV.y the path mask.
func _build_mesh() -> void:
	var n := vertex_count_side
	var count := heights.size()
	var vertices := PackedVector3Array()
	vertices.resize(count)
	var colors := PackedColorArray()
	colors.resize(count)
	var soft_ledge := _blur(ledge_mask, 2, 3)
	rock_cover = _zeroed(count)
	for idx in count:
		var slope := 1.0 - normals[idx].y
		var shader_ledge := minf(soft_ledge[idx] * 1.8, 1.0)
		rock_cover[idx] = maxf(smoothstep(ROCK_SLOPE_START, ROCK_SLOPE_END, slope), shader_ledge)
	var uvs := PackedVector2Array()
	uvs.resize(count)
	# UV2: the downhill direction of a strongly smoothed heightmap, which on
	# beaches points out to sea at right angles to the coast. The terrain
	# shader turns the sand texture by it, so the ripples run along the shore.
	var smooth_heights := _blur(heights, 4, 3)
	var downhill := PackedVector2Array()
	downhill.resize(count)
	for j in n:
		for i in n:
			var gx := smooth_heights[j * n + mini(i + 1, n - 1)] - smooth_heights[j * n + maxi(i - 1, 0)]
			var gz := smooth_heights[mini(j + 1, n - 1) * n + i] - smooth_heights[maxi(j - 1, 0) * n + i]
			var g := Vector2(-gx, -gz)
			downhill[j * n + i] = g.normalized() if g.length() > 0.0001 else Vector2(1.0, 0.0)
	for j in n:
		for i in n:
			var idx := j * n + i
			var p := vertex_position_2d(i, j)
			vertices[idx] = Vector3(p.x, heights[idx], p.y)
			colors[idx] = Color(minf(soft_ledge[idx] * 1.8, 1.0), stream_mask[idx], plot_mask[idx], beach_mask[idx])
			uvs[idx] = Vector2(zone[idx], path_mask[idx])

	var indices := PackedInt32Array()
	indices.resize(cells * cells * 6)
	var w := 0
	for j in cells:
		for i in cells:
			var a := j * n + i
			var b := a + 1
			var c := a + n
			var d := c + 1
			if absf(heights[b] - heights[c]) + diagonal_bias < absf(heights[a] - heights[d]):
				indices[w] = a
				indices[w + 1] = b
				indices[w + 2] = c
				indices[w + 3] = b
				indices[w + 4] = d
				indices[w + 5] = c
			else:
				indices[w] = a
				indices[w + 1] = b
				indices[w + 2] = d
				indices[w + 3] = a
				indices[w + 4] = d
				indices[w + 5] = c
			w += 6

	var arrays := []
	arrays.resize(Mesh.ARRAY_MAX)
	arrays[Mesh.ARRAY_VERTEX] = vertices
	arrays[Mesh.ARRAY_NORMAL] = normals
	arrays[Mesh.ARRAY_COLOR] = colors
	arrays[Mesh.ARRAY_TEX_UV] = uvs
	arrays[Mesh.ARRAY_TEX_UV2] = downhill
	arrays[Mesh.ARRAY_INDEX] = indices
	var mesh := ArrayMesh.new()
	mesh.add_surface_from_arrays(Mesh.PRIMITIVE_TRIANGLES, arrays)
	mesh.surface_set_material(0, terrain_material if terrain_material else DEFAULT_MATERIAL)
	_get_mesh_instance().mesh = mesh


func _get_mesh_instance() -> MeshInstance3D:
	var mesh_instance := get_node_or_null("TerrainMesh") as MeshInstance3D
	if mesh_instance == null:
		mesh_instance = MeshInstance3D.new()
		mesh_instance.name = "TerrainMesh"
		add_child(mesh_instance, false, Node.INTERNAL_MODE_FRONT)
	return mesh_instance


func _zeroed(count: int) -> PackedFloat32Array:
	var array := PackedFloat32Array()
	array.resize(count)
	array.fill(0.0)
	return array


# Grid index bounds [i0, j0, i1, j1] covering a world-space rectangle.
func _index_bounds(low: Vector2, high: Vector2) -> PackedInt32Array:
	var half := world_size * 0.5
	return PackedInt32Array([
		clampi(floori((low.x + half) / cell_size), 0, cells),
		clampi(floori((low.y + half) / cell_size), 0, cells),
		clampi(ceili((high.x + half) / cell_size), 0, cells),
		clampi(ceili((high.y + half) / cell_size), 0, cells),
	])
