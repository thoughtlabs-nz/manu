# Bird Detection Service

Edge-first bird detection on Seeed XIAO ESP32-S3 Sense cameras, managed entirely by
ESPHome, posting detections to Convex, with a Vite web app on top.

```
[XIAO ESP32-S3 Sense]  --HTTPS POST-->  [Convex HTTP action]  -->  [ConvexDB]  -->  [Vite web app]
  ESPHome + on-device                     /detections (JSON)
  YOLO11n "bird" class                    /snapshots (JPEG b64)
```

## Status

- [x] Edge research — see [docs/edge-research.md](docs/edge-research.md)
- [x] ESPHome device config — [esphome/bird-cam.yaml](esphome/bird-cam.yaml)
- [x] Flashed and verified on hardware (2026-08-20): stable, camera OK, WiFi OK.
      Measured YOLO11n inference: **~15 s/cycle** — usable for lingering birds,
      but the v2 FOMO model (~150 ms) is the plan for responsiveness.
- [x] Convex backend, deployed to `enchanted-alligator-592` and verified end-to-end:
      `/detections` + `/snapshots` HTTP actions (Bearer auth via `DETECTION_API_KEY`
      env var), snapshots in Convex file storage auto-linked to detections,
      `detections:recent` / `detections:stats` queries ready for the web app.
      Dev loop: `npm run dev:backend`.
- [x] Vite web app ("Manu", `web/`) — live real-time feed off `detections:recent`
      via the Convex React client, snapshot polaroids, 24h stats. Verified live:
      a curl-posted detection appeared without refresh.
      Dev: `npm run dev --prefix web` (Convex URL in `web/.env.local`).
- [x] v2 model trained and **verified off-device** (2026-08-21) with
      [training/test_model.py](training/test_model.py), which replays the exact
      on-device preprocessing + ESPDet decode on the host. It genuinely detects
      birds with tight boxes, but it is weak: AP50 0.169 float / 0.161 int8.
      Quantization costs almost nothing; the threshold matters a lot (see
      [training/README.md](training/README.md)).
- [x] v2 **running on hardware** (2026-08-21) via `model_path:` +
      `model_family: hand_detect`, with the on-device control page.
      Detection cadence ~1/s (inference <800ms) vs v1's ~15s.
      Two export settings were required — see
      [training/README.md](training/README.md): `equalization=False` and
      esp-ppq pinned to 1.3.0. Getting this wrong = unrecoverable boot loop.
- [x] **Snapshot upload fixed** (2026-08-21). ESPHome hardcodes a 5120-byte JSON
      cap (`json/json_util.cpp`), so a base64 JPEG could never fit — the POST was
      silently truncated and Convex 400'd. This was broken in v1 too; the original
      end-to-end test used curl, which is why it never surfaced. The device now
      POSTs the **raw JPEG** with `Content-Type: image/jpeg` and metadata in
      `X-Device` / `X-Timestamp` headers; `/snapshots` accepts raw bytes (and
      still accepts the JSON+base64 form for curl testing). Verified on hardware:
      a detection arrived with its snapshot stored, linked, and species-ID'd.
- [ ] Retrain v2 on a better dataset — ~17% AP50 is the real ceiling right now

## Flashing the device

1. `pip install esphome` (or use the ESPHome dashboard)
2. `cd esphome && cp secrets.yaml.example secrets.yaml` and fill it in
3. Plug the XIAO in over USB-C (camera expansion board attached) and run:

```bash
esphome run esphome/bird-cam.yaml
```

First build compiles ESP-DL + the YOLO11 model — expect 10–20 minutes.
This build flashes over **USB serial only** (the embedded model needs a single
large app partition on the 8MB flash, leaving no room for OTA slots).

## The "hand" label, and the forked component

`model_family: hand_detect` selects the single-class **ESPDet decoder** — the
only one whose preprocessing (mean 0 / std 255, letterbox 114) and
postprocessor (strides 8/16/32) match our espdet_pico bird model.
`pedestrian_detect` and `human_face_detect` use different postprocessors, so
switching family is not an option.

The class-name table, however, is fixed at **compile time** from the family
(`vision_component.cpp`) and is never read from the `.espdl`, so everything came
out labelled `hand` — including the text burned into the uploaded JPEG. There
is no YAML option for it.

We run a **fork**: [thoughtlabs-nz/s3_vision](https://github.com/thoughtlabs-nz/s3_vision),
branch `bird-label`, whose sole change (commit `2af4dee`) relabels that one
table to `bird`. Upstream is GPL-3.0; the fork keeps that licence and the change
is described in the commit message.

```yaml
external_components:
  - source:
      type: git
      url: https://github.com/thoughtlabs-nz/s3_vision
      ref: bird-label
    components: [vision]
    refresh: 1d
```

Patching ESPHome's cached clone was tried first and **does not hold**: ESPHome
2026.8 runs `git stash push --include-untracked` + `git reset --hard
FETCH_HEAD` on that clone, silently reverting the patch mid-session and sending
detections back to `hand`. `refresh: never` did not prevent it. A fork is immune
— a reset just restores our own code. To pull upstream fixes in, fetch upstream
into the fork and rebase `bird-label`.

The detection lambda still ignores the label and takes the highest score, so
even swapping back to upstream would cost the overlay text, never a detection.

## OTA and snapshot size

**OTA works.** The custom single-`factory` partition table is gone — ESPHome
generates a dual-slot layout (`otadata` + `app0`/`app1`, 3.75MB each) and the
firmware is ~2.5MB (64.7%). Installing that table cost one final USB flash;
everything since has gone over the air:

```bash
esphome run esphome/bird-cam.yaml --device bird-cam-1.local
```

A bad build is now recoverable **without USB**, which was proven in practice: a
failed OTA left the device unreachable, safe mode came up with wifi + port 3232
only (no web/API — that port pattern is how you recognise it), and the next OTA
rescued it. The device also now reports `Bootloader rollback: supported`, which
the old single-slot table could not.

**Snapshots are 640x480 @ q75 (~24-42KB)**, up from 320x240 @ q60 (~5-9KB).
Detection is unaffected — the model always sees a 224x224 letterbox — but the
server-side species ID gets 4x the detail.

VGA also **crashed on upload** until PSRAM malloc was enabled. The snapshot
POST copies the JPEG into a `std::string` for `http_request`'s `body`, and
ESPHome's psram component sets `CONFIG_SPIRAM_USE_CAPS_ALLOC` — PSRAM is then
reachable only via `heap_caps_malloc(MALLOC_CAP_SPIRAM)`, so plain `new`
(what `std::string` uses) can only take internal RAM. A ~40KB internal
allocation competing with wifi and the HTTPS/mbedTLS buffers failed, threw
`std::bad_alloc`, and with exceptions disabled the stub called `abort()` —
surfacing as `Fault - IllegalInstruction` in a crash loop. Fixed with:

```yaml
sdkconfig_options:
  CONFIG_SPIRAM_USE_CAPS_ALLOC: "n"
  CONFIG_SPIRAM_USE_MALLOC: "y"
  CONFIG_SPIRAM_MALLOC_ALWAYSINTERNAL: "16384"   # bigger than this -> PSRAM
  CONFIG_SPIRAM_MALLOC_RESERVE_INTERNAL: "32768" # keep a DMA/ISR pool internal
```

At 320x240 the copy was only 5-9KB, which is why this stayed hidden until VGA.

VGA **boot-looped** at first. The PSRAM frame copy allocated fine (614400
bytes); the killer was `inference_task_stack_size: 8192`. ESP-DL's
resize/colour-convert path (using this component's scalar conversion stubs)
scales with frame width and overran the inference task stack. **32768** fixes
it. If you raise the resolution further, raise the stack first.

## Capture mode (collecting training data)

The v2 model is weak (AP50 ~0.17) because it was trained on COCO's bird subset:
assorted birds worldwide, mostly distant. This camera is fixed, pointed at one
NZ garden at feeder distance — a severe domain mismatch no amount of retraining
on COCO will fix. Capture mode collects in-domain data instead.

Turn on **Capture Mode** on the control page. While it is on:

- every frame is uploaded (throttled by **Capture Interval**, default 10s) to
  the `captures` table — raw training data, never linked to a detection;
- **detection reporting is suppressed**, so a collection run does not flood
  `detections` or spend money on species ID for thousands of unlabelled frames.

Then pull the set down and label it:

```bash
python3 scripts/fetch_captures.py --out captures/
# label as ONE class, "bird" — species ID is server-side, so the on-device
# model never needs to know species. Export YOLO format.
# retrain per training/README.md, gate with training/test_model.py, then OTA.
npx convex run captures:clear '{"confirm":"yes-delete-all-captures"}'
```

**Known sampling bias:** the component only encodes a JPEG when the model
produced at least one raw box (`vision_component.cpp`: `if (!dets.empty())`),
so a completely featureless frame is never captured. In practice that is
useful — the frames you get are the ones the model reacts to, which is exactly
the false-positive material worth labelling — but the set is not a uniform
sample of the scene. Budget: ~40KB/frame, 5000-capture backend cap (~14 hours
at the default interval).

## Remote / dashboard builds (ESPHome Device Builder)

Two things break when the build is offloaded to a remote builder:

**1. The model isn't shipped.** The builder sends a *bundle*, discovered by
walking the validated config for files with a **known extension** (see
`esphome/bundle.py: _KNOWN_FILE_EXTENSIONS`) plus anything a component
registers via `add_bundle_file()`. `.espdl` is neither, so you get:

```
model_path: file not found at .../bird-cam/models/espdet_pico_224_224_bird.espdl
```

Fixed in the YAML, not by patching — the machine that *creates* the bundle may
not be one you can patch:

```yaml
esphome:
  includes:
    - models        # a DIRECTORY, deliberately
```

`includes:` is collected explicitly by the bundler, and `valid_include()` tries
`cv.directory()` **first**, so a directory skips the extension check that
rejects a bare `.espdl` file. `include_file()` only emits an `#include` for
`.h/.hpp/.tcc`, and PlatformIO ignores `.espdl`, so the copy into `src/` is
inert. Keep `models/` free of anything you don't want shipped — the whole
directory goes into every bundle. Verify with:

```bash
esphome bundle --list-only bird-cam.yaml    # must list models/*.espdl
```

**2. Pin the PlatformIO toolchain.** ESPHome **2026.8+** defaults `esp-idf`
builds to a native CMake toolchain. `s3_vision` is PlatformIO-only — it wires
ESP-DL in via `add_platformio_option("extra_scripts")` and PIO build flags, none
of which run under CMake — so the build dies with:

```
fatal error: dl_tool.hpp: No such file or directory
```

The generated project is the tell: CMake builds emit `CMakeLists.txt` +
`sdkconfig` and **no** `platformio.ini`. Fix in the `esp32:` block:

```yaml
esp32:
  toolchain: platformio
```

Accepted by older ESPHome too, so both build paths stay identical.

**3. Nothing to patch.** This used to require patching the component cache on
every machine that compiles (a build server keeps a separate cache per peer
under `.esphome/.remote_builds/<peer>/.esphome/external_components/`). Since the
component is now a fork carrying the label change, every builder gets it
automatically.

The dashboard config dir is still a **separate copy** of everything —
`bird-cam.yaml` and `models/` have to be synced to it.

## Device control page

The device serves its own control page at `http://bird-cam-1.local/` (ESPHome
`web_server` v3, assets embedded in flash so it works without internet). The
same entities appear automatically in Home Assistant over the native API:

| Group | Controls |
|-------|----------|
| Detection | Min Confidence, Detection Enabled, Snapshot Uploads, Run Inference Now, Bird Detected, Bird Confidence |
| Image | Brightness, Contrast, Saturation, White Balance, Special Effect, Reapply Camera Settings |
| Exposure & Gain | Auto Exposure, AEC DSP, AE Level, Manual Exposure, Auto Gain, Manual Gain, Gain Ceiling |
| Orientation | Vertical Flip, Horizontal Mirror |
| Diagnostics | WiFi Signal, Uptime, Internal Temperature, Restart |

Every setting is `restore_value`, and an `on_boot` script re-applies the
restored values to the OV2640 (a restored slider position otherwise only
*displays* the old value without pushing it to the sensor).

Note this is the plain `web_server`, **not** `esp32_camera_web_server` — the
latter's MJPEG streamer starves ESP-DL of internal RAM and boot-loops the
device. To see what the camera sees, use `scripts/snapshot.py` over the API.

## How the edge works (v2)

- `esp32_camera` grabs 320×240 RGB565 frames into PSRAM.
- The `s3_vision` external component runs our custom **ESPDet-Pico** single-class
  bird model on-device (~124 ms/inference vs v1's ~15 s).
- A detection ≥ `bird_min_confidence` (default 0.10 — see the off-device
  measurements in [training/README.md](training/README.md)) triggers a report script:
  POST JSON (`device, species, confidence, object_count, ts`) to the Convex
  `/detections` HTTP action, plus a boxed JPEG snapshot to `/snapshots`,
  then a 30s cooldown.
- Home Assistant (optional) sees the camera stream, a `Bird Detected` occupancy
  sensor, confidence, and switches to pause detection/uploads.
- Prefer MQTT instead? A commented block at the bottom of the YAML swaps the
  POST for `mqtt.publish_json` (QoS 1).
