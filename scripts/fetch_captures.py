#!/usr/bin/env python3
"""Download capture-mode frames from Convex for labelling.

Capture mode (the `Capture Mode` switch on the device's control page) uploads
raw frames to the `captures` table — unlabelled training data that is never
linked to a detection and never sent to the paid species-ID pass.

This pulls them down so you can label them (Roboflow / CVAT / Edge Impulse all
work; export YOLO format, which is what training/esp-detection consumes).

    python3 scripts/fetch_captures.py --out captures/

Then, once you are sure the download is good:

    npx convex run captures:clear '{"confirm":"yes-delete-all-captures"}'
"""

import argparse
import datetime as dt
import json
import os
import subprocess
import sys
import urllib.request

PAGE = 200


def convex_run(fn, args):
    """Call a Convex function via the CLI and return its parsed JSON result."""
    out = subprocess.run(
        ["npx", "convex", "run", fn, json.dumps(args)],
        capture_output=True, text=True,
        cwd=os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    )
    if out.returncode != 0:
        sys.exit(f"convex run {fn} failed:\n{out.stderr.strip()}")
    text = out.stdout
    start = text.find("[") if "[" in text else text.find("{")
    if start < 0:
        sys.exit(f"no JSON in convex output:\n{text}")
    return json.loads(text[start:])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="captures", help="output directory")
    args = ap.parse_args()
    os.makedirs(args.out, exist_ok=True)

    stats = convex_run("captures:stats", {})
    print(f"{stats['count']} captures, {stats['totalBytes']/1e6:.1f} MB "
          f"(cap {stats['limit']})")
    if not stats["count"]:
        return

    before, got, skipped = None, 0, 0
    while True:
        page = convex_run("captures:list",
                          {"limit": PAGE, **({"before": before} if before else {})})
        if not page:
            break
        for row in page:
            if not row.get("url"):
                skipped += 1
                continue
            ts = dt.datetime.fromtimestamp(row["receivedAt"] / 1000)
            name = f"{ts:%Y%m%d-%H%M%S}-{row['id'][-6:]}.jpg"
            dest = os.path.join(args.out, name)
            if os.path.exists(dest):          # resumable
                continue
            with urllib.request.urlopen(row["url"], timeout=30) as r:
                data = r.read()
            with open(dest, "wb") as f:
                f.write(data)
            got += 1
            if got % 25 == 0:
                print(f"  {got} downloaded...")
        before = page[-1]["receivedAt"]
        if len(page) < PAGE:
            break

    print(f"\ndownloaded {got} -> {args.out}/" + (f"  ({skipped} had no URL)" if skipped else ""))
    print("Next: label as a single 'bird' class, export YOLO format, then\n"
          "retrain per training/README.md. Clear the backend when you're done:\n"
          "  npx convex run captures:clear '{\"confirm\":\"yes-delete-all-captures\"}'")


if __name__ == "__main__":
    main()
