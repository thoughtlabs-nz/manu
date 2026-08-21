# Design sources

Original artwork, kept out of `web/` so it is never bundled or served — the app
uses the processed copy at `web/src/assets/fantail.png`.

## Fantail.png

The pīwakawaka logo, as supplied: 2816×1536, 5.2MB, artwork on a textured
cream background.

It cannot be used directly. The background is `rgb(250,248,243)` where the
site's paper is `#f5efe3`, so it would render as a pale rectangle sitting on
top of the page's paper and `.grain` overlay.

Regenerate the web assets after changing this file:

```bash
training/venv/bin/python design/make_logo.py
```

That keys the background out by **luminance** (a flat colour-key leaves speckle,
because the artwork carries paper texture), floors the resulting alpha (the same
texture otherwise leaves every edge faintly non-zero, which defeats `getbbox()`
and prevents cropping), crops to content, and writes:

- `web/src/assets/fantail.png` — 239×216, ~45KB, transparent. Displayed 72px
  tall, so this is a 3× export.
- `web/public/favicon.png`, `web/public/apple-touch-icon.png`

The artwork's own ink colour (`#62360c`) is detected and preserved rather than
being recoloured to `--rust`.
