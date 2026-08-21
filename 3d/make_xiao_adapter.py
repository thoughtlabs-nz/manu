#!/usr/bin/env python3
"""
Drop-in camera adapter for the SML_BirdFeeder CamHolder tube.

Replaces the Blink Outdoor (71 x 71 x 32 mm) with a Seeed XIAO ESP32S3 Sense
(21 x 17.8 x 15 mm incl. expansion board + camera).

Host geometry, measured off SML_BirdFeeder_CamHolder_HOLES_Update.stl:
    z  0.0 -> 2.7   front bezel, window 54.04 sq  R10.0
    z  2.7 -> 30.4  main cavity,        71.61 sq  R7.51
    z 30.4 -> 44.0  cap rebate,         77.12 sq   (cap ring lands here)

The adapter plugs the window with a spigot at the front and runs the full
27.7 mm depth of the cavity, so the existing cap ring clamps its back face.
No modification to any original STL.

z = 0 is the outer (weather) face.  Run with no args to write both STLs.
"""
import numpy as np, trimesh
from shapely.geometry import box, Point

# ---------------------------------------------------------------- host part
WINDOW, WINDOW_R = 54.04, 10.00     # front bezel opening
CAVITY, CAVITY_R = 71.61,  7.51     # main cavity
BEZEL_T          =  3.00            # front bezel thickness (measured)
CAVITY_DEPTH     = 27.10            # bezel back (3.00) -> cap shoulder (30.15)
CLEAR            =  0.20            # per-side clearance (FDM slip fit)

# ------------------------------------------------------------ XIAO ESP32S3 Sense
BOARD_W, BOARD_H, BOARD_D = 21.0, 17.8, 15.0   # Seeed: 21 x 17.8 x 15 mm
BOARD_FIT       = 0.6           # total added to W/H for the pocket
POCKET_DEPTH    = 16.0          # >= BOARD_D
LENS_HOLE_D     = 9.0           # through-hole for the OV2640 barrel
LENS_RECESS     = 13.0          # square pocket for the lens holder
LENS_RECESS_D   = 3.5           # its depth
FACE_T          = 2.0           # material in front of the lens holder
LENS_OFFSET     = (0.0, 0.0)    # (x, y) shift of lens vs. board centre

USB_W, USB_Z0   = 11.0, 10.0    # side notch: width, and z where it starts
SHELL_T         = 4.0           # wall thickness of the pocket boss
SCREW_Y         = 12.5          # retainer screw positions (0, +/-SCREW_Y)
PILOT_D         = 1.70          # M2 self-tapper pilot
BOSS_D          = 6.0

SEG = 64        # arc resolution


def rounded_square(size, r, inset=0.0):
    """Rounded square centred on the origin, offset inward by `inset`."""
    h = size / 2.0
    p = box(-h + r, -h + r, h - r, h - r).buffer(r, quad_segs=SEG)
    return p.buffer(-inset, quad_segs=SEG) if inset else p


def prism(poly, z0, z1):
    m = trimesh.creation.extrude_polygon(poly, z1 - z0)
    m.apply_translation([0, 0, z0])
    return m


def cube(w, h, z0, z1, cx=0.0, cy=0.0):
    return prism(box(cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2), z0, z1)


def build_adapter():
    z_pocket0 = FACE_T + LENS_RECESS_D              # 5.5  board front face
    z_pocket1 = z_pocket0 + POCKET_DEPTH            # 21.5 board back face
    z_back    = BEZEL_T + CAVITY_DEPTH              # 30.4 clamped by the cap

    boss_w = BOARD_W + BOARD_FIT + 2 * SHELL_T
    boss_h = max(BOARD_H + BOARD_FIT + 2 * SHELL_T, 2 * (SCREW_Y + BOSS_D / 2))

    # --- solid: spigot fills the bezel window, plug fills the cavity
    spigot = prism(rounded_square(WINDOW, WINDOW_R, CLEAR), 0.0, BEZEL_T)
    plug   = prism(rounded_square(CAVITY, CAVITY_R, CLEAR), BEZEL_T, z_back)
    part   = spigot.union(plug)

    # --- hollow it out from the back, then put the pocket boss back in
    hollow = prism(rounded_square(CAVITY, CAVITY_R, CLEAR + SHELL_T),
                   z_pocket0, z_back + 1.0)
    part = part.difference(hollow)
    part = part.union(cube(boss_w, boss_h, z_pocket0 - 0.01, z_pocket1))

    # The 4 mm shell already runs the full depth to z_back, so its rear edge
    # is the face the cap ring clamps.  No extra rim/ribs -- they would block
    # rear access to the board and the USB cable route.

    lx, ly = LENS_OFFSET

    # --- lens through-hole + holder recess
    part = part.difference(
        prism(Point(lx, ly).buffer(LENS_HOLE_D / 2, quad_segs=SEG), -1.0, FACE_T + 0.01))
    part = part.difference(
        cube(LENS_RECESS, LENS_RECESS, FACE_T, z_pocket0 + 0.01, lx, ly))

    # --- board pocket, open to the rear
    part = part.difference(
        cube(BOARD_W + BOARD_FIT, BOARD_H + BOARD_FIT, z_pocket0, z_pocket1 + 0.01))

    # --- USB-C side notch, open rearward
    part = part.difference(
        cube(SHELL_T * 3, USB_W, USB_Z0, z_pocket1 + 0.01,
             cx=(BOARD_W + BOARD_FIT) / 2 + SHELL_T / 2))

    # --- retainer screw bosses + pilot holes
    for sy in (SCREW_Y, -SCREW_Y):
        part = part.union(
            prism(Point(0, sy).buffer(BOSS_D / 2, quad_segs=SEG), z_pocket0, z_pocket1))
        part = part.difference(
            prism(Point(0, sy).buffer(PILOT_D / 2, quad_segs=SEG),
                  z_pocket1 - 8.0, z_pocket1 + 0.01))
    return part


def build_retainer():
    """Small bar that screws across the back of the board."""
    L, W, T = 2 * SCREW_Y + BOSS_D + 2, 8.0, 3.0
    bar = cube(W, L, 0.0, T)
    for sy in (SCREW_Y, -SCREW_Y):
        bar = bar.difference(
            prism(Point(0, sy).buffer(2.3 / 2, quad_segs=SEG), -0.5, T + 0.5))
    return bar


if __name__ == '__main__':
    import os
    d = os.path.dirname(os.path.abspath(__file__))
    for name, mesh in [('XIAO_CamAdapter.stl', build_adapter()),
                       ('XIAO_CamAdapter_Retainer.stl', build_retainer())]:
        mesh.export(os.path.join(d, name))
        print(f"{name:32s} watertight={mesh.is_watertight} "
              f"vol={mesh.volume:8.0f}mm3 ext={np.round(mesh.extents,2)}")
