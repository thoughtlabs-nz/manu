"""Build a YOLO-format single-class 'bird' dataset from COCO 2017.

Downloads only bird-class images (COCO category 16) using the annotation
files' coco_url fields — no full COCO download needed (~500MB total).

Output layout (what esp-detection/ultralytics expects):
  datasets/coco_bird/images/{train,val}/*.jpg
  datasets/coco_bird/labels/{train,val}/*.txt   (class cx cy w h, normalized)
"""
import concurrent.futures as cf
import json
import os
import sys
import urllib.request
import zipfile
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).parent
DATASET = ROOT / "esp-detection" / "datasets" / "coco_bird"
ANN_URL = "http://images.cocodataset.org/annotations/annotations_trainval2017.zip"
BIRD_CAT = 16
MAX_TRAIN = 3500  # cap; COCO has ~3200 bird train images anyway


def ensure_annotations() -> Path:
    zip_path = ROOT / "annotations_trainval2017.zip"
    ann_dir = ROOT / "annotations"
    if not (ann_dir / "instances_val2017.json").exists():
        if not zip_path.exists():
            print("downloading COCO annotations (241MB)...")
            urllib.request.urlretrieve(ANN_URL, zip_path)
        print("extracting instances json...")
        with zipfile.ZipFile(zip_path) as z:
            for name in z.namelist():
                if "instances_" in name:
                    z.extract(name, ROOT)
    return ROOT / "annotations"


def build_split(split: str, limit: int | None) -> None:
    ann = json.loads((ensure_annotations() / f"instances_{split}2017.json").read_text())
    images = {im["id"]: im for im in ann["images"]}
    boxes = defaultdict(list)
    for a in ann["annotations"]:
        if a["category_id"] == BIRD_CAT and not a.get("iscrowd"):
            boxes[a["image_id"]].append(a["bbox"])

    ids = sorted(boxes)
    if limit:
        ids = ids[:limit]
    out_name = "train" if split == "train" else "val"
    img_dir = DATASET / "images" / out_name
    lbl_dir = DATASET / "labels" / out_name
    img_dir.mkdir(parents=True, exist_ok=True)
    lbl_dir.mkdir(parents=True, exist_ok=True)
    print(f"{split}: {len(ids)} bird images")

    def fetch(img_id: int) -> bool:
        im = images[img_id]
        dest = img_dir / im["file_name"]
        if not dest.exists():
            try:
                urllib.request.urlretrieve(im["coco_url"], dest)
            except Exception as err:  # noqa: BLE001
                print(f"failed {im['file_name']}: {err}")
                return False
        w, h = im["width"], im["height"]
        lines = []
        for x, y, bw, bh in boxes[img_id]:
            cx, cy = (x + bw / 2) / w, (y + bh / 2) / h
            lines.append(f"0 {cx:.6f} {cy:.6f} {bw / w:.6f} {bh / h:.6f}")
        (lbl_dir / (dest.stem + ".txt")).write_text("\n".join(lines) + "\n")
        return True

    with cf.ThreadPoolExecutor(max_workers=16) as ex:
        done = sum(ex.map(fetch, ids))
    print(f"{split}: {done}/{len(ids)} downloaded")


if __name__ == "__main__":
    build_split("val", None)
    build_split("train", MAX_TRAIN)
    # calibration set for quantization: first 64 val images
    calib = ROOT / "esp-detection" / "deploy" / "bird_calib"
    calib.mkdir(parents=True, exist_ok=True)
    val_imgs = sorted((DATASET / "images" / "val").glob("*.jpg"))[:64]
    for p in val_imgs:
        (calib / p.name).write_bytes(p.read_bytes())
    print(f"calibration set: {len(val_imgs)} images")
    print("done")
    sys.exit(0)
