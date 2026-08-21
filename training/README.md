# Training the v2 bird model (ESPDet-Pico)

Everything heavy here is gitignored; this file + `fetch_coco_birds.py` are the
reproducible recipe. Output: an int8 `.espdl` single-class bird detector
(224×224, ~124 ms/inference on ESP32-S3) loaded by `s3_vision` in
[../esphome/bird-cam.yaml](../esphome/bird-cam.yaml).

## Setup

```bash
cd training
git clone https://github.com/espressif/esp-detection
python3 -m venv venv          # python 3.11
venv/bin/pip install -r esp-detection/requirements.txt
python3 fetch_coco_birds.py   # COCO 2017 bird subset -> YOLO format + calib set
```

## Patches to the esp-detection clone

`esp-detection/cfg/datasets/coco_bird.yaml`:

```yaml
path: datasets/coco_bird
train: images/train
val: images/val
test:

names:
  0: bird
```

`esp-detection/train.py` — in `train_setting`, change:

```python
epochs=120,
patience=30,
batch=64,
device="mps",   # Apple Silicon GPU (was "cpu")
```

## ⚠️ From-scratch training does not converge — use transfer learning

Discovered 2026-08-20 after ~1.5h of training showed flat loss and near-zero
mAP: **training `espdet_pico` from random initialization (`--pretrained_path
None`) does not converge**, regardless of device or optimizer. Confirmed with
three isolated diagnostics (each 8 epochs on a 240-image subset):
- MPS + `optimizer=auto` (AdamW, lr0≈0.002): mAP50 stuck ~0.0003, recall
  actively *degraded* from 0.11 → 0.014 over 29 epochs on the full dataset.
- CPU + `optimizer=auto`: same flat pattern (rules out MPS as the cause).
- CPU + SGD lr0=0.01 (Ultralytics' traditional default): same flat pattern
  (rules out optimizer choice).
- Gradient flow confirmed fine (`361,167 parameters, 361,167 gradients` at
  train start — nothing frozen), and Espressif's shipped pretrained cat
  checkpoint (`examples/cat_detection/espdet_pico_224_224_cat.pt`) scores a
  healthy mAP50=0.88 on their cat val set — so the architecture and
  inference/validation pipeline are NOT broken, only cold-start training is.

**Fix: fine-tune from the pretrained cat checkpoint instead of training from
scratch.** One epoch of fine-tuning (SGD, lr0=0.001) on the same 240-image
subset reached mAP50=0.087 — ~300x better than 29 epochs from scratch. Over
8 epochs, cls_loss dropped 3.61→1.86 (vs. flat in every from-scratch run).

```bash
python espdet_run.py \
  --class_name bird \
  --pretrained_path examples/cat_detection/espdet_pico_224_224_cat.pt \
  --dataset cfg/datasets/coco_bird.yaml \
  --size 224 224 \
  --target esp32s3 \
  --calib_data deploy/bird_calib \
  --espdl espdet_pico_224_224_bird.espdl \
  --img espdet.jpg
```

`train.py`'s `train_setting` also needs `optimizer='SGD', lr0=0.001,
momentum=0.937` (not `optimizer='auto'`) — already applied in this repo.

## Run (train → ONNX → int8 quantize → .espdl)

```bash
cd esp-detection
../venv/bin/python espdet_run.py \
  --class_name bird \
  --pretrained_path None \
  --dataset cfg/datasets/coco_bird.yaml \
  --size 224 224 \
  --target esp32s3 \
  --calib_data deploy/bird_calib \
  --espdl espdet_pico_224_224_bird.espdl \
  --img espdet.jpg
```

~1–2 h on an Apple Silicon GPU. The `.espdl` output is what matters; the CPP
project it also generates is unused (ESPHome's s3_vision loads the model via
`model_path`, single-class ESPDet decoder family).

Verify output tensor names before deploying (must be score0/1/2 + box0/1/2 or
the s3_vision postprocessor crashes):

```python
from esp_ppq.api import load_native_graph
g = load_native_graph("espdet_pico_224_224_bird.espdl")
for op in g.outputs:
    print(op.name, op.dtype, op.shape)
```

## Testing the model off-device (`test_model.py`)

Before flashing anything, `training/test_model.py` runs the model on the host
through a faithful port of the **exact** pipeline `s3_vision` uses on the
device with `model_family: hand_detect`:

1. letterbox to 224×224, centred, padded with gray 114
2. normalise mean 0 / std 255
3. forward pass → `box0/score0` (stride 8), `box1/score1` (16), `box2/score2` (32)
4. decode per `dl::detect::ESPDetPostProcessor::parse_stage` — box values are
   LTRB distances in stride units from the cell centre, score is a raw logit
   needing `sigmoid()`
5. NMS, then map boxes back to source-image pixels

Two backends:

- `onnx` — float32 reference (`runs/detect/train/weights/best.onnx`).
- `espdl` — int8. esp-ppq ships an `.espdl` *exporter* but no importer, so the
  shipped `.espdl` cannot be loaded back. (The `load_native_graph` snippet
  earlier in this file does **not** work — it expects a PPQ `.native` file and
  dies with `invalid load key, 'E'`.) Instead the backend re-runs the identical
  quantization — same ONNX, same calibration set, same settings as
  `deploy/quantize.py` — and executes the resulting graph. Quantization is
  deterministic given those inputs, so this reproduces the flashed numerics.

```bash
# annotated detections on arbitrary images
venv/bin/python test_model.py --images ../Samples/*.jpg --out test_out

# precision/recall/AP50 sweep on the COCO bird val set, float vs int8
venv/bin/python test_model.py --val --backend both
```

### Results (2026-08-21) — the model works, but it is weak

Sanity check first: the harness scores the float model at **AP50 0.169** on the
125-image val set, against Ultralytics' own **mAP50 0.147** for the same
`best.pt`. Close enough to trust the port — and the drawn boxes are tight on
real photos, so the decode is right.

| score_thr | float precision | float recall | int8 precision | int8 recall |
|-----------|-----------------|--------------|----------------|-------------|
| 0.05      | 0.257           | 0.262        | 0.317          | 0.255       |
| 0.10      | 0.404           | 0.213        | 0.455          | 0.199       |
| 0.20      | 0.561           | 0.150        | 0.644          | 0.089       |
| 0.30      | 0.632           | 0.112        | 0.789          | **0.035**   |

AP50: float 0.169, int8 0.161.

Two conclusions:

- **Quantization is not the problem.** It costs ~0.008 AP50. The int8 model is
  essentially as good as the float one.
- **The threshold matters enormously.** int8 scores are compressed relative to
  float — on a test photo the peak logit moved from +0.38 to −1.00, dropping
  sigmoid from 0.595 to 0.269. At the originally-planned `0.30` gate the device
  would report only **3.5%** of birds. Best F1 for int8 is at **0.05–0.10**,
  which is why `bird_min_confidence` ships at `0.10` and `score_threshold` at
  `0.05`.
- **The real limit is the trained model.** ~17% AP50 is low. It stopped early at
  epoch 28/120 on 3,237 images. Improving it means more/better data
  (the COCO bird crop is small and mostly distant birds) rather than more
  quantization work.

Precision at 0.10 is ~45%, so roughly half of what the device posts will not be
a bird — the server-side species ID pass (`convex/species.ts`) is what filters
those out, and it already has to reject non-birds.

## ⚠️ Export settings that make a loadable .espdl (READ THIS FIRST)

`esp-detection/requirements.txt` installs esp-ppq unpinned:

```
git+https://github.com/espressif/esp-ppq
```

That resolves to whatever master is today (1.3.7 as of 2026-08-21). Together
with the default `equalization=True` in `deploy/quantize.py`, the resulting
`.espdl` **hard-crashes the ESP32-S3 at model load**:

```
Guru Meditation Error: Core 1 panic'ed (LoadProhibited)
PC: fbs::FbsModel::get_operation_parameter(...)  EXCVADDR: 0x00000000
  dl::Model::load -> VisionDetectImpl -> initialise_detector_
```

**Cause:** esp-ppq 1.3.x emits the per-tensor quantization parameters
(scale / zero-point on `RequantizeLinear`) as **rank-0 scalars**, `dims=[]`.
The esp-dl **3.3.2** vendored inside `youkorr/s3_vision` expects **rank-1**
tensors, `dims=[1]`. It reads a zero-length shape and dereferences null.

Verified by parsing both files with esp-ppq's own FlatBuffers bindings
(`esp_ppq.parser.espdl.FlatBuffers.Dl`, schema at
`esp-dl/fbs_loader/espdl.fbs`) — see the "off-device gate" below:

| esp-ppq | rank-0 initializers | loads on device |
|---------|---------------------|-----------------|
| 1.1.0   | 0                   | ✅ |
| 1.2.0   | 0                   | ✅ |
| 1.2.12  | 0                   | ✅ |
| 1.3.0   | 0                   | ✅ |
| 1.3.7   | **14**              | ❌ boot loop |

Espressif's own `espdet_pico_224_224_hand.espdl` has 0 rank-0 initializers,
which is what made the comparison decisive.

**Fix — install esp-ppq 1.3.0 explicitly, after the requirements file:**

```bash
venv/bin/pip install --no-deps "esp-ppq==1.3.0"
```

### Off-device gate: check BEFORE you flash

A firmware that *compiles* and *embeds* the model can still boot-loop — the
model is only parsed at runtime. Two dead-end theories cost two bad flashes
before this gate existed; use it every time the model is re-exported.

```bash
venv/bin/python - <<'EOF'
from esp_ppq.parser.espdl.FlatBuffers.Dl import Model as M
buf = bytearray(open("../esphome/models/espdet_pico_224_224_bird.espdl","rb").read())
g = M.Model.GetRootAsModel(buf, 16).Graph()          # 16 = EDL2 header
r0 = sum(1 for i in range(g.InitializerLength()) if g.Initializer(i).DimsLength() == 0)
print("rank-0 initializers:", r0, "->", "OK" if r0 == 0 else "WILL BOOT LOOP")
EOF
```

Also worth knowing: the two `Resize` nodes legitimately carry an **empty**
`input[1]` (the optional ONNX `roi`). That is **correct** — Espressif's working
model has the identical construct. Do not "fix" it; patching it in changes
nothing and diverges from the reference.


### ✅ RESOLVED 2026-08-21 — the decisive fix was `equalization=False`

Two changes were made; be precise about which did the work.

**1. `quant_setting.equalization = False` — THIS is the fix (verified on hardware).**
`deploy/quantize.py` sets `equalization = True`, but esp-ppq's own
`QuantizationSettingFactory.espdl_setting()` defaults it to **False**.
Layer-wise equalization rescales weights across layers, which shifts activation
ranges and makes esp-ppq insert extra `RequantizeLinear` nodes — including on
**Split outputs**, which esp-dl 3.3.2 cannot load. Turning it off removed
exactly those nodes and the device booted.

| | RequantizeLinear placement |
|---|---|
| Espressif reference (boots) | 4 nodes, all on Relu/Add outputs |
| ours, equalization=True (crashes) | 7 nodes, incl. `/model.6/Split_output_0` and `_1` |
| ours, equalization=False (boots) | 6 nodes, none on Split outputs |

**2. esp-ppq pinned to 1.3.0.** The rank-0/rank-1 difference described above is
real and measurable, but it was changed at the same time as (1), so it is
**not proven** to be independently fatal. Keep the pin — matching the reference
costs nothing — but if you ever need 1.3.7, the thing to re-test first is
whether `equalization=False` alone is sufficient.

**How to verify a rebuilt model before flashing** — compare it structurally to
Espressif's own `espdet_pico_224_224_hand.espdl` (bundled in the s3_vision
component). That model is known to load, so it is the ground truth:

```bash
# parse both with esp-ppq's generated FlatBuffers bindings (root offset 16)
venv/bin/python - <<'EOF'
from esp_ppq.parser.espdl.FlatBuffers.Dl import Model as M
def summary(p):
    g = M.Model.GetRootAsModel(bytearray(open(p,'rb').read()), 16).Graph()
    rq = [g.Node(i).Input(0).decode() for i in range(g.NodeLength())
          if g.Node(i).OpType() and g.Node(i).OpType().decode()=="RequantizeLinear"]
    r0 = sum(1 for i in range(g.InitializerLength()) if g.Initializer(i).DimsLength()==0)
    print(f"{p.split('/')[-1]}: nodes={g.NodeLength()} rank0={r0}")
    for v in rq: print("   requantize <-", v, "  <-- BAD" if "Split_output" in v else "")
summary("../esphome/models/espdet_pico_224_224_bird.espdl")
EOF
```

Gate: **rank0 must be 0**, and **no requantize on a `Split_output`**.

### The other bottleneck was the camera, not the model

After it booted, detections were still ~20s apart — but that was
`idle_framerate: 0.05fps` in the ESPHome config (one frame every 20s), a v1
setting that made sense when YOLO11n took 15s anyway. The `vision` component is
a passive `CameraListener` and never calls `request_image()`, so the camera
stays on its idle schedule. ESPHome caps `idle_framerate` at **1fps**, which is
therefore the inference-rate ceiling in this setup.

Measured after the change: inference cadence min **0.85s**, median 1.55s — the
0.85s floor is `detection_interval_ms: 800`, so real inference is **under
800ms**, vs v1's ~15s.

### Snapshot upload: never use JSON for the JPEG

ESPHome caps JSON serialization at **5120 bytes**
(`esphome/components/json/json_util.cpp`, `max_heap_size = 5120`) — not
configurable from YAML. A 320x240 q=60 frame is ~5-9KB, so base64-in-JSON
(~33% larger again) is *always* truncated, producing malformed JSON and a 400
from Convex. Post the JPEG as a **raw body** instead:

```yaml
- http_request.post:
    url: !secret convex_snapshot_url
    request_headers:
      Content-Type: image/jpeg
      X-Device: !lambda "return App.get_name().c_str();"     # must return const char*
    body: !lambda |-
      return std::string(reinterpret_cast<const char *>(image.data), image.length);
```

Two gotchas: `request_headers` lambdas must return `const char *` (a pointer
into a temporary `std::string` dangles — use a `static` buffer for computed
values), and the body `std::string` must be built with an explicit length so
embedded NULs survive. `http_request` sends `body.length()` bytes, not `strlen`.
