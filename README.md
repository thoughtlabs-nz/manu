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
- [ ] v2 model: custom-trained FOMO/ESPDet bird model (see roadmap in research doc)

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

## How the edge works (v1)

- `esp32_camera` grabs 320×240 RGB565 frames into PSRAM.
- The `s3_vision` external component runs ESP-DL **YOLO11n (COCO)** on-device ~1×/sec;
  COCO class 14 is `bird` — no model training needed to start.
- A detection ≥ `bird_min_confidence` (default 0.40) triggers a report script:
  POST JSON (`device, species, confidence, object_count, ts`) to the Convex
  `/detections` HTTP action, plus a boxed JPEG snapshot to `/snapshots`,
  then a 30s cooldown.
- Home Assistant (optional) sees the camera stream, a `Bird Detected` occupancy
  sensor, confidence, and switches to pause detection/uploads.
- Prefer MQTT instead? A commented block at the bottom of the YAML swaps the
  POST for `mqtt.publish_json` (QoS 1).
