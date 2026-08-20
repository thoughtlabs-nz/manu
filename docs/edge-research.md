# Bird detection on the XIAO ESP32-S3 Sense — research findings (Aug 2026)

## 1. Models that actually run on this board

| Model | Input | RAM (arena) | Flash (model) | Latency (S3, int8 + ESP-NN) | Notes |
|---|---|---|---|---|---|
| Edge Impulse FOMO (MobileNetV2 0.35) | 96×96 gray | ~250 KB | ~80 KB | **143 ms (~7 fps)** measured | F1 83–85% in demos; centroids, no boxes; needs custom training |
| EI FOMO | 160×160 gray | ~600–700 KB (est.) | ~100 KB | ~350–450 ms (est.) | Better for small/distant birds |
| EI MobileNetV2 α0.35 classifier | 96×96 RGB | ~300 KB | ~300–600 KB | ~219 ms | Bird/no-bird or few-species classification |
| ESP-DL ESPDet-Pico (custom-trainable) | 224×224 RGB | n/p | ~1 MB | **124 ms** measured | Real bounding boxes; train via esp-detection repo |
| ESP-DL YOLO11n (COCO, incl. "bird") | 320×320 | large (PSRAM) | several MB | ~300–500 ms | **Pretrained — zero training needed**; marginal but workable on S3 |

Key benchmark source: Marcelo Rovai's XIAO ESP32-S3 ebook (measured on this exact board):
- FOMO: https://mjrovai.github.io/XIAO_Big_Power_Small_Board-ebook/chapter_4-5.html
- Classification: https://mjrovai.github.io/XIAO_Big_Power_Small_Board-ebook/chapter_4-4.html

Constraints: int8 quantization is effectively mandatory; ESP-NN (LX7 SIMD kernels) gives
~4–8× speedup and is used by all the paths above; 8 MB PSRAM is plenty for any of these,
the real limits are PSRAM bandwidth and camera framebuffer contention.

**No ready-made bird-species model for ESP32 exists.** Real projects (Hackster bird-feeder
builds) all ship bird/no-bird or single-class "bird" detection on-device, then save/upload
the full-res photo for species ID elsewhere. Fine-grained species classification
(CUB-200 / NABirds level) is beyond this class of hardware; ~3–10 visually distinct local
species at 70–85% accuracy is the realistic on-device ceiling.

## 2. Running models under ESPHome

ESPHome core has **no camera-inference component** (micro_wake_word is audio-only; the
tflite proposal, esphome discussion #3352, has no maintainer engagement). The workable
"all managed by ESPHome" route is `external_components` pulled from git at compile time:

1. **`youkorr/s3_vision`** — https://github.com/youkorr/s3_vision — wraps Espressif
   ESP-DL YOLO11 (COCO 80 classes, includes `bird`), ESP32-S3 only, hooks into
   `esp32_camera` (RGB565, PSRAM), exposes `on_object_detected` / `on_detection_image`
   triggers plus `vision.start/stop/inference` actions. **Chosen for v1** — zero training.
   Caveats: ~5–7 MB firmware needs a custom partition table (no OTA on 8 MB flash);
   XIAO S3 Sense not on the author's tested list (same chip + OV2640 as tested boards).
2. **`nliaudat/esphome_ai_component`** — https://github.com/nliaudat/esphome_ai_component —
   `tflite_micro_helper` loads arbitrary TFLite models (local or fetched remotely into
   PSRAM with CRC check) + camera crop/scale utils. The polished pipelines are
   meter-reading-oriented; a bird classifier needs a thin custom wrapper. **The v2 path**
   for a custom-trained FOMO/ESPDet bird model (small model ⇒ default partitions ⇒ OTA back).
3. **Edge Impulse** has no maintained ESPHome component — deploying an EI model means
   wrapping its exported C++ library yourself.

Escape hatch: the same YAML's camera entity can feed Home Assistant/Frigate for
server-side inference with zero hardware changes.

## 3. Posting detections

| Method | Verdict |
|---|---|
| **HTTPS POST (`http_request.post`) to a Convex HTTP action** | **Chosen.** Fits the Convex stack directly, no broker, full JSON with lambdas, HTTPS works out of the box (ESP32 ships a CA bundle). Convex HTTP actions are served at `https://<deployment>.convex.site/<path>`. No built-in retry — cooldown script + `on_error` logging mitigate. |
| MQTT (`mqtt.publish_json`, QoS 1) | Most robust delivery (broker queueing, LWT liveness) but adds a broker between device and Convex — someone still has to bridge MQTT→Convex. Right choice if Home Assistant is the hub. Included commented-out in the YAML. |
| `homeassistant.event` | Couples everything to HA; not used. |

Gotcha: with `api:` enabled but no Home Assistant connected, ESPHome reboots every
15 min unless `reboot_timeout: 0s` is set (done in the config).

## 4. Board facts (XIAO ESP32-S3 Sense)

- 8 MB flash, 8 MB **octal** PSRAM (`psram: {mode: octal, speed: 80MHz}`), OV2640, 2.4 GHz WiFi only.
- Camera pins (verified against ESPHome docs): XCLK GPIO10@20MHz, I²C SDA GPIO40/SCL GPIO39,
  Y2–Y9 = 15,17,18,16,14,12,11,48, VSYNC 38, HREF 47, PCLK 13.
- Framework: **esp-idf** (required by ESP-DL; also ESPHome's recommended default).
- Known failure mode: `esp32_camera Setup Failed: ESP_FAIL` usually means wrong PSRAM
  mode or the Sense camera expansion board isn't seated (esphome/issues#7215).
- Camera uses LEDC timer 1; user LED on GPIO21 (inverted).

## 5. Measured on-device results (2026-08-20, actual XIAO S3 Sense)

- Firmware builds (~4.8 MB factory image) and flashes; camera + model initialize.
- **Watchdog fix required:** s3_vision's default `inference_task_priority: 5` starves
  ESPHome's `loopTask` (both pinned to core 1) during long inference → `task_wdt` abort
  and reboot loop. Fixed with `inference_task_priority: 1` (timeslices with the loop)
  plus `CONFIG_ESP_TASK_WDT_TIMEOUT_S: "30"`.
- **Real YOLO11n inference cadence on this board: ~15 s/cycle** (camera reports
  4 frames/60 s), much slower than the ~300–500 ms hoped for. Stable, and fine for
  birds that linger at a feeder, but it will miss quick visits — strengthens the case
  for the v2 custom FOMO model (143 ms measured on this hardware).
- Flashing quirk: the native USB port re-enumerates with a new name when esptool
  resets the chip; if upload fails with "Device not configured", re-run
  `esphome upload` against the new `/dev/cu.usbmodem*` that appears.
- `E esp_ota_ops: not found otadata` in logs is expected/harmless (no OTA partitions).

## 6. Roadmap

- **v1 (now):** pretrained YOLO11n "bird" class via s3_vision → POST detection + snapshot to Convex.
- **v2:** train FOMO (96×96, ~150 ms) or ESPDet-Pico (224×224, ~124 ms) on ~200–500 images
  captured *from the actual feeder camera position* (the `on_detection_image` snapshots
  become the training set). Small model restores OTA and cuts latency 3×.
- **v3 (optional):** second-stage on-device classifier for a handful of local species, or
  server-side species ID over the uploaded snapshots (the more accurate option).

### Sources
- ESPHome camera/pinout: https://esphome.io/components/esp32_camera/ · https://wiki.seeedstudio.com/XIAO_ESP32S3_esphome/
- No official tflite component: https://github.com/orgs/esphome/discussions/3352
- s3_vision announcement: https://community.home-assistant.io/t/share-esphome-custom-component-for-espressif-edge-ai-yolo11-on-esp32-s3/1010951
- ESP-DL model zoo: https://github.com/espressif/esp-dl/blob/master/models/README.md · training: https://github.com/espressif/esp-detection
- Edge Impulse XIAO S3 target: https://docs.edgeimpulse.com/hardware/boards/seeed-xiao-esp32s3-sense · public FOMO project: https://studio.edgeimpulse.com/public/315759/latest/deployment
- Prior-art feeders: https://www.hackster.io/justinelutz/solar-powered-tinyml-bird-feeder-142f61 · https://www.hackster.io/Ralphjy/dual-ai-camera-e04757 · https://www.electromaker.io/project/view/bird-detection-with-tinyml-and-a-blues-notecard
- ESPHome mqtt/api/http_request: https://esphome.io/components/mqtt/ · https://esphome.io/components/api/ · https://esphome.io/components/http_request/
