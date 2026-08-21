# Camera holder — XIAO ESP32S3 Sense conversion

The four supplied STLs were designed around a **Blink Outdoor** camera
(71 × 71 × 32 mm). Measured off `SML_BirdFeeder_CamHolder_HOLES_Update.stl`,
the holder is a square *tube*, open at both ends:

| Zone        | z range      | Opening              | Wall     |
|-------------|--------------|----------------------|----------|
| Front bezel | 0 – 3.00     | 54.04 sq, R10.00     | 14.47 mm |
| Main cavity | 3.00 – 30.15 | 71.61 sq, R7.51      | 5.67 mm  |
| Cap rebate  | 30.15 – 44.01| 77.12 sq             | 2.97 mm  |

`LRG_BirdFeeder_V2_CamHolderCap` is a retaining **ring** (76.9 sq × 10.31,
64.88 mm hole) that slots into the rebate. z = 0 is the outdoor face.

The XIAO ESP32S3 Sense is 21 × 17.8 × 15 mm — the cavity is ~3× oversized and
the 54 mm bezel window would let rain straight in. The outer 83 mm can't be
reduced: the back wall panel has a matching ring the tube passes through.

## Solution — drop-in adapter, originals untouched

`XIAO_CamAdapter.stl` (71.21 sq × 30.10, ~54 cm³)

* Front **spigot** (53.64 sq, R9.8) plugs the bezel window flush with the
  outdoor face and self-centres the part.
* **Plug body** fills the 71.6 cavity at 0.20 mm/side clearance.
* Rear face lands at z = 30.10, 0.05 mm shy of the cap shoulder — the existing
  cap ring clamps it. No press fit, no glue, fully reversible to a Blink.
* **Ø9.0 mm lens hole** through a 2.0 mm face, backed by a 13 × 13 × 3.5 mm
  recess for the OV2640 lens holder.
* **21.6 × 18.4 × 16 mm board pocket** (0.6 mm total fit on a 21 × 17.8 board).
* **USB-C notch**: the +X pocket wall is open from z = 10 rearward, so the cable
  exits into the rear cavity and out through the cap ring — no disassembly to
  reflash, and nothing to seal on the weather face.
* Two M2 bosses (Ø1.7 pilot) take `XIAO_CamAdapter_Retainer.stl`, a 33 × 8 × 3
  bar that screws across the back of the board.

Verified against the original mesh: **0.000 mm³ interference**, watertight,
single body.

## Regenerating

    python3 make_xiao_adapter.py

Everything is a named constant at the top of the script. The ones you're most
likely to touch:

* `LENS_HOLE_D` (9.0) — open out if your barrel is fatter. Vignetting headroom
  is fine up to ~5 mm of lens setback at this diameter.
* `LENS_RECESS` / `LENS_RECESS_D` (13.0 / 3.5) — lens holder footprint.
* `LENS_OFFSET` (0, 0) — shift the hole if the camera isn't centred on your
  board. Measure once the board is in the pocket.
* `BOARD_FIT` (0.6) — tighten or loosen the pocket for your printer.

## Printing

Front face down on the bed, no supports needed (the pocket and rear cavity are
open upward). The 2.0 mm face over the lens hole is the only thin section —
use 4+ perimeters there.
