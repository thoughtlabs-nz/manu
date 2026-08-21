#!/usr/bin/env python3
"""
Off-device test harness for the v2 bird model.

Replicates the EXACT on-device pipeline that `s3_vision` runs with
`model_family: hand_detect` (the single-class ESPDet decoder), so what you see
here is what the ESP32-S3 will see:

  1. letterbox to 224x224, centered, padded with gray 114
  2. normalize mean=0 std=255  (i.e. x/255)
  3. forward pass -> box0/score0 (stride 8), box1/score1 (16), box2/score2 (32)
  4. decode per dl::detect::ESPDetPostProcessor::parse_stage
     (center +/- distance*stride, sigmoid on the raw score logit)
  5. NMS, then map boxes back to source-image pixels

Two backends:
  onnx   float32 reference (runs/detect/train/weights/best.onnx) - the
         model as trained, before quantization.
  espdl  int8-quantized graph (the .espdl actually flashed to the device),
         executed on the host via esp-ppq. Differences vs. onnx are
         quantization damage.

Usage:
  python test_model.py --images ../Samples/*.jpg --out ../scratch/out
  python test_model.py --val                       # PR + AP50 on the COCO bird val set
  python test_model.py --val --backend both        # float vs int8 side by side
"""

import argparse
import glob
import os
import sys

import numpy as np
from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_ONNX = os.path.join(HERE, "esp-detection/runs/detect/train/weights/best.onnx")
DEFAULT_CALIB = os.path.join(HERE, "esp-detection/deploy/bird_calib")
DEFAULT_VAL = os.path.join(HERE, "esp-detection/datasets/coco_bird")

INPUT_SIZE = 224
PAD_VALUE = 114
# (stride_y, stride_x, offset_y, offset_x) - matches the s3_vision hand_detect
# postprocessor construction in vision_detect_inner.cpp
STAGES = [(8, 8, 4, 4), (16, 16, 8, 8), (32, 32, 16, 16)]


# --------------------------------------------------------------------------
# preprocessing
# --------------------------------------------------------------------------
def letterbox(img):
    """Centered letterbox to 224x224 padded with 114, mirroring ESP-DL's
    ImagePreprocessor::preprocess(). Returns (chw_float, scale, bl, bt)."""
    src_w, src_h = img.size
    scale = min(INPUT_SIZE / src_w, INPUT_SIZE / src_h)
    new_w, new_h = int(scale * src_w), int(scale * src_h)

    # ESP-DL pads only the shorter axis (pad/2 on the leading edge)
    border_left = (INPUT_SIZE - new_w) // 2
    border_top = (INPUT_SIZE - new_h) // 2

    resized = img.convert("RGB").resize((new_w, new_h), Image.BILINEAR)
    canvas = Image.new("RGB", (INPUT_SIZE, INPUT_SIZE), (PAD_VALUE,) * 3)
    canvas.paste(resized, (border_left, border_top))

    arr = np.asarray(canvas, dtype=np.float32) / 255.0      # std = 255
    chw = np.transpose(arr, (2, 0, 1))[None, ...]           # NCHW
    return chw, scale, border_left, border_top


def sigmoid(x):
    return 1.0 / (1.0 + np.exp(-x))


# --------------------------------------------------------------------------
# ESPDet decode (port of dl_detect_espdet_postprocessor.cpp)
# --------------------------------------------------------------------------
def decode(outputs, scale, border_left, border_top, score_thr):
    """outputs: dict name -> NCHW array. Returns list of (score, x1,y1,x2,y2)."""
    inv_scale = 1.0 / scale
    boxes = []

    for i, (stride_y, stride_x, offset_y, offset_x) in enumerate(STAGES):
        score = outputs[f"score{i}"][0, 0]      # (H, W) raw logits
        box = outputs[f"box{i}"][0]             # (4, H, W) distances in stride units
        H, W = score.shape

        ys, xs = np.nonzero(sigmoid(score) >= score_thr)
        for y, x in zip(ys, xs):
            center_y = y * stride_y + offset_y
            center_x = x * stride_x + offset_x
            l, t, r, b = box[:, y, x]

            x1 = ((center_x - l * stride_x) - border_left) * inv_scale
            y1 = ((center_y - t * stride_y) - border_top) * inv_scale
            x2 = ((center_x + r * stride_x) - border_left) * inv_scale
            y2 = ((center_y + b * stride_y) - border_top) * inv_scale
            boxes.append((float(sigmoid(score[y, x])), x1, y1, x2, y2))

    boxes.sort(key=lambda b: -b[0])
    return boxes


def iou(a, b):
    ax1, ay1, ax2, ay2 = a
    bx1, by1, bx2, by2 = b
    ix1, iy1 = max(ax1, bx1), max(ay1, by1)
    ix2, iy2 = min(ax2, bx2), min(ay2, by2)
    iw, ih = max(0.0, ix2 - ix1), max(0.0, iy2 - iy1)
    inter = iw * ih
    ua = max(0.0, ax2 - ax1) * max(0.0, ay2 - ay1)
    ub = max(0.0, bx2 - bx1) * max(0.0, by2 - by1)
    denom = ua + ub - inter
    return inter / denom if denom > 0 else 0.0


def nms(boxes, nms_thr, max_det):
    kept = []
    for cand in boxes:
        if all(iou(cand[1:], k[1:]) <= nms_thr for k in kept):
            kept.append(cand)
            if len(kept) >= max_det:
                break
    return kept


# --------------------------------------------------------------------------
# backends
# --------------------------------------------------------------------------
class OnnxBackend:
    name = "onnx"

    def __init__(self, path):
        import onnxruntime as ort
        self.sess = ort.InferenceSession(path, providers=["CPUExecutionProvider"])
        self.input_name = self.sess.get_inputs()[0].name
        self.output_names = [o.name for o in self.sess.get_outputs()]

    def __call__(self, chw):
        outs = self.sess.run(self.output_names, {self.input_name: chw})
        return dict(zip(self.output_names, outs))


class EspdlBackend:
    """int8 numerics, executed on the host.

    esp-ppq has an .espdl *exporter* but no importer, so we cannot load the
    shipped .espdl back. Instead we re-run the identical quantization
    (same ONNX, same calibration set, same settings as deploy/quantize.py)
    and execute the resulting graph. Quantization is deterministic given
    those inputs, so this reproduces the numerics of the flashed model.
    """
    name = "espdl"

    def __init__(self, onnx_path, calib_dir, target="esp32s3", num_of_bits=8):
        import shutil
        import tempfile
        import torch
        from torch.utils.data import DataLoader
        from esp_ppq import QuantizationSettingFactory
        from esp_ppq.api import espdl_quantize_onnx
        from esp_ppq.executor import TorchExecutor

        sys.path.insert(0, os.path.join(HERE, "esp-detection"))
        from deploy.quantize import CaliDataset

        self.torch = torch

        # espdl_quantize_onnx rewrites the onnx in place - work on a copy
        tmp_dir = tempfile.mkdtemp(prefix="espdl_eval_")
        tmp_onnx = os.path.join(tmp_dir, "model.onnx")
        shutil.copy(onnx_path, tmp_onnx)

        dataset = CaliDataset(calib_dir, img_shape=(INPUT_SIZE, INPUT_SIZE))
        loader = DataLoader(dataset=dataset, batch_size=1, shuffle=False)

        setting = QuantizationSettingFactory.espdl_setting()
        setting.equalization = True
        setting.equalization_setting.iterations = 4
        setting.equalization_setting.value_threshold = 0.4
        setting.equalization_setting.opt_level = 2
        setting.equalization_setting.interested_layers = None

        graph = espdl_quantize_onnx(
            onnx_import_file=tmp_onnx,
            espdl_export_file=os.path.join(tmp_dir, "model.espdl"),
            calib_dataloader=loader,
            calib_steps=32,
            input_shape=[1, 3, INPUT_SIZE, INPUT_SIZE],
            target=target,
            num_of_bits=num_of_bits,
            collate_fn=lambda b: b.to("cpu"),
            setting=setting,
            device="cpu",
            error_report=False,
            skip_export=True,
            export_test_values=False,
            verbose=0,
            inputs=None,
        )
        self.graph = graph
        self.executor = TorchExecutor(graph, device="cpu")
        self.output_names = list(graph.outputs.keys())

    def __call__(self, chw):
        t = self.torch.from_numpy(chw)
        outs = self.executor.forward(t, output_names=self.output_names)
        return {n: o.detach().cpu().numpy() for n, o in zip(self.output_names, outs)}


def make_backend(kind, onnx_path, calib_dir):
    if kind == "onnx":
        return OnnxBackend(onnx_path)
    if kind == "espdl":
        return EspdlBackend(onnx_path, calib_dir)
    raise ValueError(kind)


def infer(backend, img, score_thr, nms_thr, max_det):
    chw, scale, bl, bt = letterbox(img)
    outputs = backend(chw)
    boxes = decode(outputs, scale, bl, bt, score_thr)
    return nms(boxes, nms_thr, max_det)


# --------------------------------------------------------------------------
# modes
# --------------------------------------------------------------------------
def run_images(backends, paths, args):
    os.makedirs(args.out, exist_ok=True)
    for path in paths:
        img = Image.open(path).convert("RGB")
        print(f"\n{os.path.basename(path)}  ({img.size[0]}x{img.size[1]})")
        annotated = img.copy()
        draw = ImageDraw.Draw(annotated)
        colors = {"onnx": (0, 200, 0), "espdl": (255, 90, 0)}

        for backend in backends:
            dets = infer(backend, img, args.score_thr, args.nms_thr, args.max_det)
            if not dets:
                print(f"  {backend.name:6s} no detections >= {args.score_thr}")
            for score, x1, y1, x2, y2 in dets:
                print(f"  {backend.name:6s} bird {score:.3f}  "
                      f"[{x1:.0f},{y1:.0f} {x2:.0f},{y2:.0f}]")
                draw.rectangle([x1, y1, x2, y2], outline=colors[backend.name], width=3)
                draw.text((x1 + 4, y1 + 4), f"{backend.name} {score:.2f}",
                          fill=colors[backend.name])

        dest = os.path.join(args.out, f"det_{os.path.splitext(os.path.basename(path))[0]}.jpg")
        annotated.save(dest, quality=90)
        print(f"  -> {dest}")


def load_gt(label_path, w, h):
    """YOLO normalized cxcywh -> absolute xyxy."""
    boxes = []
    if not os.path.exists(label_path):
        return boxes
    for line in open(label_path):
        parts = line.split()
        if len(parts) < 5:
            continue
        cx, cy, bw, bh = (float(v) for v in parts[1:5])
        boxes.append(((cx - bw / 2) * w, (cy - bh / 2) * h,
                      (cx + bw / 2) * w, (cy + bh / 2) * h))
    return boxes


def run_val(backends, args):
    img_dir = os.path.join(args.dataset, "images/val")
    lbl_dir = os.path.join(args.dataset, "labels/val")
    paths = sorted(glob.glob(os.path.join(img_dir, "*")))
    if not paths:
        sys.exit(f"no val images under {img_dir}")

    for backend in backends:
        records = []       # (score, is_true_positive)
        n_gt = 0
        for path in paths:
            img = Image.open(path).convert("RGB")
            w, h = img.size
            stem = os.path.splitext(os.path.basename(path))[0]
            gt = load_gt(os.path.join(lbl_dir, stem + ".txt"), w, h)
            n_gt += len(gt)

            # low threshold so the PR curve is complete; report at score_thr too
            dets = infer(backend, img, 0.01, args.nms_thr, 100)
            matched = set()
            for score, x1, y1, x2, y2 in dets:
                best_i, best_iou = -1, 0.0
                for i, g in enumerate(gt):
                    if i in matched:
                        continue
                    v = iou((x1, y1, x2, y2), g)
                    if v > best_iou:
                        best_i, best_iou = i, v
                if best_iou >= 0.5:
                    matched.add(best_i)
                    records.append((score, True))
                else:
                    records.append((score, False))

        records.sort(key=lambda r: -r[0])
        tp = np.cumsum([1 if r[1] else 0 for r in records])
        fp = np.cumsum([0 if r[1] else 1 for r in records])
        recall = tp / max(n_gt, 1)
        precision = tp / np.maximum(tp + fp, 1)

        # 101-point interpolated AP50 (COCO style)
        ap = 0.0
        for t in np.linspace(0, 1, 101):
            p = precision[recall >= t]
            ap += (p.max() if p.size else 0.0) / 101

        print(f"\n=== {backend.name} : {len(paths)} val images, {n_gt} ground-truth birds ===")
        print(f"  AP50 {ap:.4f}")
        print(f"  {'thr':>6} {'dets':>6} {'TP':>5} {'precision':>10} {'recall':>8} {'F1':>7}")
        for thr in (0.05, 0.10, 0.15, 0.20, 0.25, 0.30, 0.40, 0.50):
            at = [r for r in records if r[0] >= thr]
            tp_at = sum(1 for r in at if r[1])
            pr = tp_at / len(at) if at else 0.0
            rc = tp_at / max(n_gt, 1)
            f1 = 2 * pr * rc / (pr + rc) if (pr + rc) else 0.0
            print(f"  {thr:6.2f} {len(at):6d} {tp_at:5d} {pr:10.4f} {rc:8.4f} {f1:7.4f}")


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--images", nargs="*", default=[])
    p.add_argument("--val", action="store_true")
    p.add_argument("--dataset", default=DEFAULT_VAL)
    p.add_argument("--onnx", default=DEFAULT_ONNX)
    p.add_argument("--calib", default=DEFAULT_CALIB)
    p.add_argument("--backend", choices=["onnx", "espdl", "both"], default="onnx")
    p.add_argument("--score-thr", type=float, default=0.30)
    p.add_argument("--nms-thr", type=float, default=0.50)
    p.add_argument("--max-det", type=int, default=10)
    p.add_argument("--out", default=os.path.join(HERE, "test_out"))
    args = p.parse_args()

    kinds = ["onnx", "espdl"] if args.backend == "both" else [args.backend]
    backends = []
    for kind in kinds:
        try:
            backends.append(make_backend(kind, args.onnx, args.calib))
        except Exception as exc:                      # noqa: BLE001
            print(f"[warn] backend '{kind}' unavailable: {exc}", file=sys.stderr)
    if not backends:
        sys.exit("no usable backend")

    if args.val:
        run_val(backends, args)
    if args.images:
        run_images(backends, args.images, args)
    if not args.val and not args.images:
        p.error("give --images and/or --val")


if __name__ == "__main__":
    main()
