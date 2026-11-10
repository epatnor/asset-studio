# Öppnar en GLB i Blenders fönster: tom scen, materialvy, modellen i bild. Argument: glb.
import sys
import bpy
GLB = sys.argv[sys.argv.index("--") + 1]
for o in list(bpy.data.objects):
    bpy.data.objects.remove(o)
bpy.ops.import_scene.gltf(filepath=GLB)


def show():
    for win in bpy.context.window_manager.windows:
        for area in win.screen.areas:
            if area.type != "VIEW_3D":
                continue
            area.spaces.active.shading.type = "MATERIAL"
            area.spaces.active.overlay.show_wireframes = True
            area.spaces.active.overlay.wireframe_threshold = 1.0
            area.spaces.active.overlay.wireframe_opacity = 0.35
            region = next(r for r in area.regions if r.type == "WINDOW")
            with bpy.context.temp_override(window=win, area=area, region=region):
                bpy.ops.object.select_all(action="SELECT")
                bpy.ops.view3d.view_selected()
    return None


bpy.app.timers.register(show, first_interval=1.0)
