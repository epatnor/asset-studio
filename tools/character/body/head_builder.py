"""Bygger ett lågpolyhuvud ur en framvy och en sidovy: kontur, volym och några få former. Ingen AI-modell, inget mall-nät.

  .venv/bin/python tools/head_builder.py '{"name": "yvonne", "front": "...", "side": "...", "out": "out/yvonne_head.glb"}'

Stegen, som Patrik beskrev dem:
1. Konturerna läses av (tools/head_measure.py): sidans profil ger mittlinjen, framvyn bredden.
2. Volymen är ringar mellan banden: en superellips per höjd, utan näsa och läppar.
3. Formerna är en tabell med punkter och polygoner för halva ansiktet: ögonhålans båge, brygga och bryn, näskilen
   mellan ögonen, munnen och käken. Punkterna placeras med mätvärdena, så samma tabell passar andra ansikten.
4. Den andra halvan speglas. Bakhuvud, hjässa och hals är ett glest rutnät som sys ihop med ansiktets rand.
5. Knuten är en egen del, ur det av konturen som inte är skalle.

Skriver en ny GLB (aldrig över en gammal), build/head/<namn>.json med polygonerna och en rad JSON med mått."""
import json
import sys
from pathlib import Path

import numpy as np
import trimesh
from PIL import Image, ImageDraw
from scipy.interpolate import PchipInterpolator
from scipy.ndimage import gaussian_filter1d

ROOT = Path(__file__).resolve().parents[3]   # asset-studio
HERE = ROOT / "build/body"                    # body-gens arbetsyta: build/, out/, images/ (flyttad 2026-11-10)
TOOLS = Path(__file__).resolve().parent
SPEL = ROOT.parents[1]                        # ~/Spelutveckling (img2mesh, lowpoly-test)
sys.path.insert(0, str(TOOLS))
from head_measure import edges, measure, next_extreme, read  # noqa: E402

PIXELS_PER_METER = 1440.0
TOP_Y = 1.702
SUPER = 2.3
HAIR_LIFT = 0.006
# Patriks åtgärder: halsen krymps i x och z men inte i höjd, och näsans ändpunkter dras rakt ut.
NECK_SCALE = 0.82
NOSE_OUT = 0.006
# Bakom ansiktet: vinklarna runt huvudet, 0 fram och 180 bak.
BACK_COLUMNS = [100, 125, 150, 180]
CROWN_COLUMNS = [0, 40, 75, 100, 125, 150, 180]


class Head:
    def __init__(self, front_path, side_path, neck_z):
        self.m = measure(front_path, side_path)
        front_pixels, front_mask = read(front_path)
        _, side_mask = read(side_path)
        self.front_mask, self.side_mask = front_mask, side_mask
        self.skin = (front_pixels[..., 0] > 165) & (front_pixels[..., 0] - front_pixels[..., 1] > 30) & (front_pixels[..., 1] > 85)
        rows, front_left, front_right = edges(front_mask)
        side_rows, side_left, side_right = edges(side_mask)
        self.rows = rows
        m = self.m
        self.center = m["center"]
        count = front_mask.shape[0]
        fill = lambda values: np.interp(np.arange(count), np.where(~np.isnan(values))[0], values[~np.isnan(values)])
        self.side_left = gaussian_filter1d(fill(side_left), 1.5)
        self.side_right = gaussian_filter1d(fill(side_right), 1.5)
        self.front_half = gaussian_filter1d(fill((front_right - front_left) / 2), 1.5)

        # Halsen sätter sidovyns nollpunkt för djupet, så att huvudet hamnar rätt på kroppen.
        neck_row = int(m["under_chin"] + (m["rows"][1] - m["under_chin"]) * 0.35)
        self.neck_row = neck_row
        self.side_zero = (self.side_left[neck_row] + self.side_right[neck_row]) / 2
        self.neck_z = neck_z

        # Skallens topp är där profilen hoppar från knuten till hjässan.
        lefts = fill(side_left)
        start = int(side_rows[0])
        jumps = np.diff(lefts[start:m["hairline"]])
        self.skull_top = int(start + np.argmin(jumps) + 1)
        # Bakhuvudet: knuten slutar där konturen slutar gå inåt snabbt, under knutens största bredd.
        widest = int(start + np.argmax(self.side_right[start:m["hairline"] + 30]))
        # Under knuten når konturen en dal och går sedan lite utåt igen, över nacken med håret.
        lowest, row = widest + 10, widest + 10
        while row < m["tip"] and self.side_right[row] <= self.side_right[lowest] + 1.2:
            if self.side_right[row] < self.side_right[lowest]:
                lowest = row
            row += 1
        self.nape_row = int(lowest)
        self.nape_x = float(self.side_right[lowest])

        # Ansiktets bas utan näsa och läppar: bara punkter där profilen inte har någon form att skydda.
        keys = [m["hairline"], m["brow_row"], m["nasion"], m["subnasale"], m["upper_lip"], m["sulcus"], m["chin"], m["under_chin"]]
        keys = sorted(set(keys))
        values = [self.side_left[row] for row in keys]
        values[keys.index(m["upper_lip"])] = (self.side_left[m["subnasale"]] + self.side_left[m["sulcus"]]) / 2
        self.base_front = PchipInterpolator(keys, values, extrapolate=True)
        self.jaw_table = None

    # --- Mått ---
    def y(self, row):
        return TOP_Y - (row - self.m["rows"][0]) / PIXELS_PER_METER

    def z_of(self, x_pixel):
        return self.neck_z + (self.side_zero - x_pixel) / PIXELS_PER_METER

    def width(self, row):
        """Halva bredden i bildpunkter, utan öron och hårslingor."""
        row = int(row)
        m = self.m
        high, low = m["hairline"], m["subnasale"]
        if row <= high:
            top = self.skull_top
            full = self.front_half[high]
            if row <= top:
                return 1.0
            return full * np.sqrt(max(0.0, 1 - ((high - row) / (high - top)) ** 2))
        # Från hårfästet smalnar huvudet mot käken. Hårslingor och öron räknas inte som huvudets bredd.
        # Skallen behåller sin bredd förbi örat och drar sig in först mot käken.
        jaw = self.jaw_width(max(row, low))
        if row < low:
            start = self.front_half[high]
            return start + (jaw - start) * ((row - high) / (low - high)) ** 2.5
        # Under hakan är det halsen som gäller.
        return float(self.front_half[row]) if row >= m["under_chin"] else max(jaw, self.front_half[m["under_chin"] + 8] * 0.98)

    def jaw_width(self, row):
        """Ansiktets halva bredd under ögonen: huden utåt från en punkt utanför munnen, tills håret eller bakgrunden tar vid."""
        m = self.m
        if self.jaw_table is None:
            rows = np.arange(int(m["eye_y"] + m["eye_half"]), m["under_chin"], 2)
            start = int(self.center + m["mouth_x"] + 8)
            values = []
            for r in rows:
                x, last, gap = start, start, 0
                while x < self.skin.shape[1] - 1 and gap < 3:
                    x += 1
                    if self.skin[r, x]:
                        last, gap = x, 0
                    else:
                        gap += 1
                values.append(last - self.center)
            self.jaw_table = (rows, gaussian_filter1d(np.array(values, float), 2.0))
        rows, values = self.jaw_table
        # Under munnen går huden över i halsen utan kant, så där följer käken en båge ned till hakan.
        taper_start = m["mouth"] + 6
        if row <= taper_start:
            return float(np.interp(row, rows, values))
        full = float(np.interp(taper_start, rows, values))
        t = min(1.0, (row - taper_start) / (m["under_chin"] + 4 - taper_start))
        return full * (1 - t ** 1.6) ** 0.5

    def front_x(self, row):
        """Ansiktets främsta punkt på raden, utan näsa och läppar."""
        row = int(row)
        m = self.m
        if row < m["hairline"]:
            return self.side_left[row]
        return float(self.base_front(min(row, m["under_chin"])))

    def back_x(self, row):
        row = int(row)
        m = self.m
        if row >= self.nape_row:
            return self.side_right[row]
        # Ovanför nacken döljer knuten skallen, så kurvan går i en ellips upp till hjässan.
        middle = self.side_left[m["hairline"]] / 2 + self.nape_x / 2
        height = self.nape_row - self.skull_top
        t = min(1.0, (self.nape_row - row) / height)
        return middle + (self.nape_x - middle) * np.sqrt(max(0.0, 1 - t * t))

    def middle_x(self, row):
        return (self.front_x(row) + self.back_x(row)) / 2

    def surface(self, angle, row):
        """Punkten på volymen: vinkeln 0 är fram och 180 bak, för höger halva sedd framifrån."""
        a = np.radians(angle)
        c, s = np.cos(a), np.sin(a)
        half = self.width(row)
        middle = self.middle_x(row)
        reach = self.front_x(row) - middle if c >= 0 else middle - self.back_x(row)
        # Superellipsen gör ansiktet plattare framtill än en vanlig ellips.
        scale = (abs(c) ** SUPER + abs(s) ** SUPER) ** (-1 / SUPER)
        x_pixel = half * s * scale
        depth = middle + reach * c * scale if c >= 0 else middle + reach * c * scale
        return np.array([x_pixel / PIXELS_PER_METER, self.y(row), self.z_of(depth)])

    def on_face(self, x_pixels, row, depth=0.0):
        """Punkt på ansiktets bas, x bildpunkter från mittlinjen, med depth meter ut från ytan."""
        half = max(self.width(row), abs(x_pixels) * 1.02, 1.0)
        share = min(abs(x_pixels) / half, 1.0)
        middle = self.middle_x(row)
        forward = (1 - share ** SUPER) ** (1 / SUPER)
        x_pixel = middle + (self.front_x(row) - middle) * forward
        return np.array([x_pixels / PIXELS_PER_METER, self.y(row), self.z_of(x_pixel) + depth])

    def on_profile(self, row, side_row=None, depth=0.0):
        """Mittlinjens verkliga profil. Sidovyns rader ligger ibland några bildpunkter från framvyns."""
        return np.array([0.0, self.y(row), self.z_of(self.side_left[int(side_row if side_row is not None else row)]) + depth])

    # --- Formerna ---
    def face_points(self):
        m = self.m
        H, Br, B, N, Ey, T, Su = m["hairline"], m["brow_row"], m["brow"], m["nasion"], m["eye_y"], m["tip"], m["subnasale"]
        UL, Mo, LL, Sc, Ch, Un = m["upper_lip"], m["mouth"], m["lower_lip"], m["sulcus"], m["chin"], m["under_chin"]
        Ex, Eh, Mx = m["eye_x"], m["eye_half"], m["mouth_x"]
        W = self.width
        J = self.jaw_width
        profile_gap = (self.side_left[N] - self.side_left[m["brow"]]) / PIXELS_PER_METER
        hollow = max(0.006, profile_gap * 1.25)
        p = {}
        # Mittlinjen, från hårfästet till halsen.
        p["m_hair"] = self.on_profile(H)
        p["m_fore"] = self.on_profile((H + Br) // 2)
        p["m_glab"] = self.on_profile(B)
        p["m_nasion"] = self.on_profile(N)
        p["m_bridge"] = self.on_profile((N + T) // 2)
        p["m_tip"] = self.on_profile(T)
        p["m_sub"] = self.on_profile(Su)
        p["m_ulip"] = self.on_profile(UL, m["side_upper_lip"])
        p["m_mouth"] = self.on_profile(Mo, (m["side_upper_lip"] + m["side_lower_lip"]) // 2 + 2, -0.003)
        p["m_llip"] = self.on_profile(LL, m["side_lower_lip"])
        p["m_sulcus"] = self.on_profile(Sc)
        p["m_chin"] = self.on_profile(Ch)
        p["m_under"] = self.on_profile(Un - 1)
        # Pannan och hårfästet.
        Sk = J(Ey + Eh)
        p["h1"] = self.on_face(Sk * 0.5, H + (Br - H) * 0.1)
        p["f_out"] = self.on_face(Sk * 0.84, H + (Br - H) * 0.5)
        p["f1"] = self.on_face(Sk * 0.46, (H + Br) // 2, 0.002)
        p["f2"] = self.on_face(Sk * 0.96, Br + 2)
        # Brynets brygga: bågen över ögat, som också är ögonhålans tak.
        p["b_in"] = self.on_face(Ex - Eh * 0.95, Br + 10, 0.0015)
        p["b_mid"] = self.on_face(Ex - Eh * 0.1, Br + 1, 0.0025)
        p["b_peak"] = self.on_face(Ex + Eh * 0.62, Br - 5, 0.003)
        p["b_out"] = self.on_face(Ex + Eh * 1.28, Br + 9, 0.0)
        p["t_e"] = self.on_face(Sk, Ey - 2, -0.001)
        # Ögonhålans kant: mellan brynets brygga och ögat. Bågen är taket, och här börjar hålan.
        p["o_up_in"] = self.on_face(Ex - Eh * 0.72, Ey - Eh * 0.72, -hollow * 0.35)
        p["o_up"] = self.on_face(Ex + Eh * 0.15, Ey - Eh * 0.98, -hollow * 0.15)
        p["o_up_out"] = self.on_face(Ex + Eh * 1.12, Ey - Eh * 0.62, -hollow * 0.1)
        # Ögat: en ring i hålan, och ögongloben i mitten.
        p["e_in"] = self.on_face(Ex - Eh, Ey + 3, -hollow)
        p["e_up_in"] = self.on_face(Ex - Eh * 0.5, Ey - Eh * 0.48, -hollow * 0.75)
        p["e_up"] = self.on_face(Ex + Eh * 0.05, Ey - Eh * 0.6, -hollow * 0.55)
        p["e_up_out"] = self.on_face(Ex + Eh * 0.55, Ey - Eh * 0.5, -hollow * 0.55)
        p["e_out"] = self.on_face(Ex + Eh * 1.08, Ey - 3, -hollow * 0.5)
        p["e_lo_out"] = self.on_face(Ex + Eh * 0.55, Ey + Eh * 0.32, -hollow * 0.7)
        p["e_lo"] = self.on_face(Ex, Ey + Eh * 0.4, -hollow * 0.55)
        p["e_lo_in"] = self.on_face(Ex - Eh * 0.5, Ey + Eh * 0.34, -hollow * 0.8)
        p["e_c"] = self.on_face(Ex, Ey, -hollow * 0.45)
        # Kinden under ögat.
        p["c_in"] = self.on_face(Ex - Eh * 0.75, Ey + Eh * 0.95, 0.0005)
        p["c_mid"] = self.on_face(Ex + Eh * 0.3, Ey + Eh * 1.25, 0.0055)
        p["c_out"] = self.on_face(Sk * 0.99, Ey + Eh * 1.0, 0.0)
        # Näsan: en kil som börjar smal mellan ögonen och breddas nedåt.
        tip_z = self.z_of(self.side_left[T])
        wing = Eh * 1.0
        p["nb"] = np.array([Eh * 0.3 / PIXELS_PER_METER, self.y(N + 3), self.z_of(self.side_left[N + 3]) - 0.0035])
        p["ns"] = np.array([Eh * 0.36 / PIXELS_PER_METER, self.y((N + T) // 2), self.z_of(self.side_left[(N + T) // 2]) - 0.0045])
        base_wing = self.on_face(wing, Su - 6)
        p["nw"] = np.array([base_wing[0], base_wing[1], base_wing[2] + (tip_z - base_wing[2]) * 0.32])
        p["nb2"] = np.array([Eh * 0.34 / PIXELS_PER_METER, self.y(Su - 2), self.z_of(self.side_left[Su]) + 0.0015])
        # Vecket där näsans sida möter kinden.
        p["nc"] = self.on_face(Eh * 0.85, (N + T) // 2 + (T - N) * 0.15, -0.0015)
        p["n_tip"] = np.array([Eh * 0.34 / PIXELS_PER_METER, self.y(T + 3), tip_z - 0.0045])
        # Munnen.
        for name, share in (("m_tip", 1.0), ("n_tip", 1.0), ("nb2", 0.5)):
            p[name][2] += NOSE_OUT * share
        p["cl"] = self.on_face(Mx * 1.35, Su + 6, 0.002)
        p["ph"] = self.on_face(Mx * 0.22, UL - 4, 0.0)
        p["ph"][2] = p["m_ulip"][2] - 0.0005
        p["lu"] = self.on_face(Mx * 0.6, UL + 3, 0.0)
        p["lu"][2] = p["m_ulip"][2] - 0.003
        p["lm"] = self.on_face(Mx * 0.55, Mo, 0.0)
        p["lm"][2] = p["m_mouth"][2] - 0.001
        p["mc"] = self.on_face(Mx, Mo - 1, -0.002)
        p["ll"] = self.on_face(Mx * 0.62, LL - 3, 0.0)
        p["ll"][2] = p["m_llip"][2] - 0.002
        # Hakan och käken.
        p["cs1"] = self.on_face(Mx * 0.72, Sc, 0.0)
        p["cs2"] = self.on_face(min(Mx * 0.56, J(Ch + 8) * 0.5), Ch + 8, 0.0005)
        p["j1"] = self.on_face(J(Su) * 0.96, Su, 0.0)
        p["j2"] = self.on_face(J(Mo + 8) * 0.9, Mo + 8, 0.0)
        p["j3"] = self.on_face(J(Ch - 2) * 0.86, Ch - 2, -0.001)
        # Under käken går ytan bakåt mot halsen.
        neck_z = self.z_of(self.side_left[self.neck_row - 18])
        p["u1"] = np.array([Mx * 0.62 / PIXELS_PER_METER, self.y(Un + 1), p["m_under"][2] - 0.018])
        # Käkvinkeln, bakåt och uppåt från hakan, som bär upp käklinjen i sidovyn.
        p["j4"] = np.array([J(Mo + 8) * 0.86 / PIXELS_PER_METER, self.y(Un - (Un - Mo) * 0.35), self.z_of(self.side_left[Mo]) * 0.25 + neck_z * 0.75])
        return p

    # Polygonerna för halva ansiktet, med framsidan utåt. Mittlinjen delas med andra halvan.
    FACE_POLYGONS = [
        # Pannan.
        "m_hair h1 f1 m_fore", "h1 f_out f2 f1",
        "m_fore f1 b_in m_glab", "f1 b_mid b_in", "f1 f2 b_peak b_mid", "f2 b_out b_peak",
        # Ögonhålans båge: brygga över, bågen ned runt ögat.
        "b_in b_mid o_up o_up_in", "b_mid b_peak o_up", "b_peak b_out o_up_out o_up",
        "o_up_in o_up e_up e_up_in", "o_up o_up_out e_up_out e_up", "o_up_out e_out e_up_out",
        "b_out t_e e_out o_up_out", "b_in o_up_in e_up_in e_in", "m_glab b_in nb m_nasion", "b_in e_in nb",
        # Ögat.
        "e_in e_up_in e_c", "e_up_in e_up e_c", "e_up e_up_out e_c", "e_up_out e_out e_c",
        "e_out e_lo_out e_c", "e_lo_out e_lo e_c", "e_lo e_lo_in e_c", "e_lo_in e_in e_c",
        # Under ögat.
        "e_in e_lo_in c_in nb", "e_lo_in e_lo c_mid c_in", "e_lo e_lo_out c_mid", "e_lo_out e_out t_e c_out c_mid",
        # Näsan: kilen mellan ögonen.
        "m_nasion nb ns m_bridge", "m_bridge ns n_tip m_tip", "nb c_in nc ns", "c_in nw nc", "ns nc nw", "ns nw n_tip",
        "m_tip n_tip nb2 m_sub", "n_tip nw nb2",
        # Kinden ned mot munnen och käken.
        "c_in c_mid cl nw", "c_mid c_out j1 cl",
        # Överläppen och munnen.
        "m_sub nb2 ph m_ulip", "nb2 nw lu ph", "nw cl mc lu",
        "m_ulip ph lm m_mouth", "ph lu mc lm",
        # Underläppen.
        "m_mouth lm ll m_llip", "lm mc ll",
        # Hakan och käkens kant.
        "cl j1 j2 mc", "m_llip ll cs1 m_sulcus", "ll mc cs1", "mc j2 j3 cs1",
        "m_sulcus cs1 cs2 m_chin", "cs1 j3 cs2",
        # Under hakan.
        "m_chin cs2 u1 m_under", "cs2 j3 j4 u1",
    ]
    # Ansiktets yttre rand, från hårfästet runt till halsen.
    FACE_OUTLINE = ["m_hair", "h1", "f_out", "f2", "b_out", "t_e", "c_out", "j1", "j2", "j3", "j4", "u1", "m_under"]


def strip(first, second):
    """Fyller glipan mellan två kedjor med trianglar, kortaste tvärgången först."""
    faces = []
    a, b = 0, 0
    return faces, a, b


class Builder:
    def __init__(self, head):
        self.head = head
        self.points = []
        self.index = {}
        self.polygons = []

    def add(self, position, key=None):
        self.points.append(np.array(position, float))
        number = len(self.points) - 1
        if key:
            self.index[key] = number
        return number

    def join(self, left, right):
        """Trianglar mellan två kedjor med hörn från början till slut."""
        i, j = 0, 0
        P = self.points
        distance = lambda a, b: np.linalg.norm(P[a] - P[b])
        while i < len(left) - 1 or j < len(right) - 1:
            if j == len(right) - 1 or (i < len(left) - 1 and distance(left[i + 1], right[j]) <= distance(left[i], right[j + 1])):
                self.polygons.append([left[i], left[i + 1], right[j]])
                i += 1
            else:
                self.polygons.append([left[i], right[j + 1], right[j]])
                j += 1

    def grid(self, rings):
        """Rutor mellan ringar med lika många hörn."""
        for upper, lower in zip(rings, rings[1:]):
            for a, b, c, d in zip(upper, upper[1:], lower[1:], lower):
                self.polygons.append([a, b, c, d])

    def build(self):
        head, m = self.head, self.head.m
        face = head.face_points()
        for key, position in face.items():
            self.add(position, key)
        for polygon in Head.FACE_POLYGONS:
            self.polygons.append([self.index[name] for name in polygon.split()])

        # Hjässan: ringar från hårfästet till toppen. Den nedersta ringen delar hörn med pannans rand.
        H = m["hairline"]
        top = head.skull_top
        crown_rows = [H - (H - top) * share for share in (0.4, 0.72, 0.92)]
        crown = []
        for row in crown_rows:
            crown.append([self.add(head.surface(a, int(row))) for a in CROWN_COLUMNS[:-1]] + [self.add(head.surface(180, int(row)))])
        pole = self.add(np.array([0.0, head.y(top), head.z_of((head.side_left[top] + head.back_x(top)) / 2)]))

        # Bakhuvudet och nacken: ett rutnät av kolumner från örat till mitten bak.
        rows = [H, m["brow_row"], int(m["eye_y"]), m["tip"], m["subnasale"], m["mouth"], m["chin"], m["under_chin"] + 8]
        back = [[self.add(head.surface(a, row)) for a in BACK_COLUMNS] for row in rows]
        self.grid(back)
        first_column = [ring[0] for ring in back]

        # Hårfästets ring: mittlinjen och pannans rand fram, rutnätets översta rad bak.
        def lifted(name, out=HAIR_LIFT, sideways=0.0):
            position = self.points[self.index[name]]
            return self.add(position + np.array([np.sign(position[0]) * sideways, HAIR_LIFT * 0.35, out]))
        hair_edge = [lifted("m_hair"), lifted("h1"), lifted("f_out", HAIR_LIFT, 0.004)]
        skin_edge = [self.index["m_hair"], self.index["h1"], self.index["f_out"]]
        self.grid([skin_edge, hair_edge])
        side_edge = [lifted("f2", HAIR_LIFT * 0.6, 0.006), lifted("t_e", HAIR_LIFT * 0.3, 0.007)]
        self.polygons.append([self.index["f_out"], hair_edge[2], side_edge[0], self.index["f2"]])
        self.polygons.append([self.index["f2"], side_edge[0], side_edge[1], self.index["b_out"], ])
        self.polygons.append([self.index["b_out"], side_edge[1], self.index["t_e"]])
        hair_ring = hair_edge + back[0]
        self.grid(crown)
        for a in range(len(crown[-1]) - 1):
            self.polygons.append([crown[-1][a], crown[-1][a + 1], pole])
        self.grid([hair_ring, crown[0]])

        # Sidan: pannans och käkens rand mot rutnätets första kolumn.
        at_t_e, at_j4 = Head.FACE_OUTLINE.index("t_e"), Head.FACE_OUTLINE.index("j4")
        lower = [self.index[name] for name in Head.FACE_OUTLINE[at_t_e:at_j4 + 1]]
        self.join([hair_edge[2], side_edge[0], side_edge[1]] + lower, first_column)

        # Halsens topp: under käken och runt om, och rutnätets sista rad.
        neck_top = m["under_chin"] + 8
        front_of_neck = [self.add(head.surface(a, neck_top)) for a in (0, 40, 75)]
        self.join([self.index["m_under"], self.index["u1"], self.index["j4"]], front_of_neck)
        self.polygons.append([self.index["j4"], front_of_neck[2], back[-1][0]])
        neck_rings = [front_of_neck + back[-1]]

        # Halsen ned till snittet.
        columns = [0, 40, 75] + BACK_COLUMNS
        bottom = m["rows"][1] - int((m["rows"][1] - m["under_chin"]) * 0.42)
        for row in (int((neck_top + bottom) / 2), bottom):
            neck_rings.append([self.add(head.surface(a, row)) for a in columns])
        self.grid(neck_rings)
        self.neck_bottom = neck_rings[-1]
        # Halsen krymper bara i x och z, så att hakan står ut mer. Nackens bakkant ligger kvar, så halsen följer med bakåt.
        for ring in neck_rings:
            nape_z = float(self.points[ring[-1]][2])
            for v in ring:
                self.points[v] = self.points[v] * np.array([NECK_SCALE, 1.0, 1.0])
                self.points[v][2] = nape_z + (self.points[v][2] - nape_z) * NECK_SCALE
        self.mirror()

    def mirror(self):
        """Spegla: hörn på mittlinjen delas, övriga får en tvilling."""
        twin = {}
        for number, position in enumerate(list(self.points)):
            if abs(position[0]) < 1e-6:
                twin[number] = number
            else:
                twin[number] = self.add(position * np.array([-1.0, 1.0, 1.0]))
        self.polygons += [[twin[v] for v in reversed(polygon)] for polygon in list(self.polygons)]
        # Halsens botten stängs med en fläkt tills huvudet sitter på en kropp.
        ring = self.neck_bottom + [twin[v] for v in reversed(self.neck_bottom[1:-1])]
        self.neck_ring = ring
        self.cap = []
        center = self.add(np.mean([self.points[v] for v in ring], axis=0))
        self.cap_center = center
        for a, b in zip(ring, ring[1:] + ring[:1]):
            self.polygons.append([a, b, center])
            self.cap.append(len(self.polygons) - 1)


def bun_part(head, builder):
    """Knuten: det av sidovyns kontur som ligger bakom skallen, som en liten ellipsoid."""
    m = head.m
    rows = np.arange(m["rows"][0], head.nape_row)
    behind = []
    for row in rows:
        limit = head.back_x(row) + 6
        columns = np.where(head.side_mask[row])[0]
        if len(columns) and columns[-1] > limit:
            behind.append((row, limit, columns[-1]))
    if not behind:
        return None
    first, last = behind[0][0], behind[-1][0]
    low = min(item[1] for item in behind)
    high = max(item[2] for item in behind)
    above = [row for row in rows if head.side_mask[row].any() and row < head.skull_top]
    top = min(above) if above else first
    center_row = (top + last) / 2
    center_x = (low + high) / 2 - (high - low) * 0.08
    radius_y = (last - top) / 2 / PIXELS_PER_METER
    radius_z = (high - low) / 2 * 1.05 / PIXELS_PER_METER
    radius_x = min(head.front_half[top + (head.skull_top - top) // 2] / PIXELS_PER_METER, radius_y * 1.1)
    center = np.array([0.0, head.y(center_row), head.z_of(center_x)])
    start = len(builder.points)
    rings = []
    segments = 8
    for lat in (35, 80, 125, 165):
        a = np.radians(lat)
        ring = []
        for k in range(segments):
            b = 2 * np.pi * k / segments
            ring.append(builder.add(center + np.array([radius_x * np.sin(a) * np.cos(b), radius_y * np.cos(a), radius_z * np.sin(a) * np.sin(b)])))
        rings.append(ring)
    north = builder.add(center + np.array([0, radius_y, 0]))
    south = builder.add(center - np.array([0, radius_y, 0]))
    for upper, lower in zip(rings, rings[1:]):
        for k in range(segments):
            n = (k + 1) % segments
            builder.polygons.append([upper[k], upper[n], lower[n], lower[k]])
    for k in range(segments):
        n = (k + 1) % segments
        builder.polygons.append([north, rings[0][n], rings[0][k]])
        builder.polygons.append([south, rings[-1][k], rings[-1][n]])
    return {"points": len(builder.points) - start, "rows": [int(top), int(last)]}


def ear_part(head, builder):
    """Örat: en tunn platta på huvudets sida, från brynet till under näsan, ur framvyns utbuktning och sidovyns plats."""
    m = head.m
    top, bottom = m["brow_row"] + 2, m["subnasale"] - 8
    middle_row = (top + bottom) / 2
    # Öronen sticker ut utanför hårets volym, eller så långt som framvyn visar.
    out_x = float(head.front_half[int(middle_row)] + 1) / PIXELS_PER_METER
    head_x = head.width(middle_row) / PIXELS_PER_METER * 0.97
    length = (bottom - top) / PIXELS_PER_METER
    z_center = head.z_of(head.middle_x(middle_row)) - length * 0.05
    # Örat lutar ut bakåt: framkanten sitter mot huvudet, bakkanten står ut så långt som framvyn visar.
    outline = [(0.45, 0.0), (0.9, 0.2), (0.85, 0.55), (0.42, 1.0), (0.12, 0.7), (0.08, 0.28)]
    width = length * 0.62
    for sign in (1, -1):
        rim, root = [], []
        for u, v in outline:
            y = head.y(top + (bottom - top) * v)
            z = z_center + (0.5 - u) * width
            rim.append(builder.add([sign * (head_x + 0.002 + min(max(out_x - head_x, 0.006), 0.012) * u), y, z]))
            root.append(builder.add([sign * (head_x - 0.006), y, z + (0.5 - u) * 0.004]))
        count = len(rim)
        for k in range(count):
            n = (k + 1) % count
            builder.polygons.append([rim[k], rim[n], root[n], root[k]])
        # Skalet: en grop i mitten av örat, inte en platt skiva.
        rim_center = np.mean([builder.points[v] for v in rim], axis=0)
        bowl = builder.add(rim_center - np.array([sign * 0.004, 0.0, 0.0]))
        for k in range(count):
            builder.polygons.append([rim[k], rim[(k + 1) % count], bowl])
        builder.polygons.append(list(root))


def triangulate(polygon, points):
    if len(polygon) == 3:
        return [polygon]
    if len(polygon) == 4:
        a, b, c, d = (points[v] for v in polygon)
        if np.linalg.norm(a - c) <= np.linalg.norm(b - d):
            return [[polygon[0], polygon[1], polygon[2]], [polygon[0], polygon[2], polygon[3]]]
        return [[polygon[0], polygon[1], polygon[3]], [polygon[1], polygon[2], polygon[3]]]
    return [[polygon[0], polygon[k], polygon[k + 1]] for k in range(1, len(polygon) - 1)]


def orient(polygons, points):
    """Alla polygoner varvade åt samma håll per del, och utåt."""
    owners = {}
    for index, polygon in enumerate(polygons):
        for a, b in zip(polygon, polygon[1:] + polygon[:1]):
            owners.setdefault((min(a, b), max(a, b)), []).append(index)
    polygons = [list(p) for p in polygons]
    seen = [False] * len(polygons)
    for start in range(len(polygons)):
        if seen[start]:
            continue
        seen[start] = True
        queue, part = [start], [start]
        while queue:
            current = queue.pop()
            polygon = polygons[current]
            for a, b in zip(polygon, polygon[1:] + polygon[:1]):
                for other in owners[(min(a, b), max(a, b))]:
                    if other == current or seen[other]:
                        continue
                    if any((x, y) == (a, b) for x, y in zip(polygons[other], polygons[other][1:] + polygons[other][:1])):
                        polygons[other] = polygons[other][::-1]
                    seen[other] = True
                    queue.append(other)
                    part.append(other)
        center = np.mean([points[v] for index in part for v in polygons[index]], axis=0)
        volume = 0.0
        for index in part:
            polygon = polygons[index]
            for k in range(1, len(polygon) - 1):
                volume += np.dot(points[polygon[0]] - center, np.cross(points[polygon[k]] - center, points[polygon[k + 1]] - center))
        if volume < 0:
            for index in part:
                polygons[index] = polygons[index][::-1]
    return polygons


def overlap(head, points, triangles):
    """Hur väl huvudets konturer täcker bilderna: skärning genom union, framifrån och från sidan, ovanför halsens snitt."""
    out = {}
    m = head.m
    stop = head.m["rows"][1] - int((m["rows"][1] - m["under_chin"]) * 0.42)
    for name, mask in (("front", head.front_mask), ("side", head.side_mask)):
        canvas = Image.new("1", (mask.shape[1], mask.shape[0]))
        draw = ImageDraw.Draw(canvas)
        rows = (TOP_Y - points[:, 1]) * PIXELS_PER_METER + m["rows"][0]
        columns = points[:, 0] * PIXELS_PER_METER + head.center if name == "front" else head.side_zero - (points[:, 2] - head.neck_z) * PIXELS_PER_METER
        for tri in triangles:
            draw.polygon([(columns[v], rows[v]) for v in tri], fill=1)
        built = np.asarray(canvas, dtype=bool).copy()
        built[stop:] = False
        target = mask.copy()
        target[stop:] = False
        out[name] = round(float((built & target).sum() / max((built | target).sum(), 1)), 3)
    return out


def build_head(front, side, neck_z):
    """Huvudet som punkter och polygoner, med halsens ring och locket som stänger den."""
    head = Head(front, side, neck_z)
    builder = Builder(head)
    builder.build()
    bun_part(head, builder)
    ear_part(head, builder)
    return head, builder


def main():
    r = json.loads(sys.argv[1])
    name = r["name"]
    data = json.loads((HERE / f"build/editor/{name}.json").read_text())
    positions = np.array(data["positions"]).reshape(-1, 3)
    ring = [i for i, key in enumerate(data["keys"]) if key.startswith("torso|108|")]
    neck_z = float(positions[ring, 2].mean())
    head = Head(HERE / r["front"], HERE / r["side"], neck_z)
    builder = Builder(head)
    builder.build()
    bun = bun_part(head, builder) if r.get("bun", True) else None
    ear_part(head, builder)

    points = np.array(builder.points)
    polygons = orient(builder.polygons, points)
    triangles = [tri for polygon in polygons for tri in triangulate(polygon, points)]
    mesh = trimesh.Trimesh(points, np.array(triangles), process=False)
    head_only = [polygon for polygon in polygons]
    face_polys = len(Head.FACE_POLYGONS) * 2
    target = HERE / r["out"]
    stem, version = target.stem, 1
    while target.exists():
        version += 1
        target = target.with_name(f"{stem}_v{version}.glb")
    target.parent.mkdir(parents=True, exist_ok=True)
    material = trimesh.visual.material.PBRMaterial(name="head", baseColorFactor=[0.78, 0.72, 0.66, 1.0], metallicFactor=0.0, roughnessFactor=0.7)
    mesh.visual = trimesh.visual.TextureVisuals(material=material)
    mesh.export(target, include_normals=True)
    side_data = HERE / f"build/head/{target.stem}.json"
    side_data.parent.mkdir(parents=True, exist_ok=True)
    side_data.write_text(json.dumps({"positions": np.round(points, 5).ravel().tolist(), "polygons": head_only, "marks": head.m, "skull_top": head.skull_top, "nape_row": head.nape_row}))
    print(json.dumps({"out": str(target), "points": len(points), "polygons": len(polygons), "triangles": len(triangles), "face_polygons": face_polys,
                      "watertight": bool(mesh.is_watertight), "skull_top": head.skull_top, "nape_row": head.nape_row, "bun": bun, "overlap": overlap(head, points, triangles)}))


if __name__ == "__main__":
    main()
