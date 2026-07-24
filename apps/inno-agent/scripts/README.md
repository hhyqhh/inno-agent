# Vendored scripts

## `pptx_to_svg/` + `pptx_to_svg.py` + `console_encoding.py`

Pure-Python PPTX → SVG converter, vendored from the
[ppt-master](https://github.com/hugohe3/ppt-master) skill
(`skills/ppt-master/scripts/`).

Used by the backend `/api/workspace/pptx-preview` route (`src/server.ts`) to
render PowerPoint slides as SVG **without LibreOffice**. Invoked as a
subprocess:

```
python3 pptx_to_svg.py <file.pptx> --embed-images --inheritance-mode flat -o <outdir>
```

### Guarantees / notes

- **Standard library only** — no `pip` dependencies. Reads the `.pptx` ZIP
  directly and emits shape-level SVG (text, shapes, gradients, tables,
  base64-embedded images).
- `console_encoding.py` is imported by the CLI (`configure_utf8_stdio`) and
  **must stay alongside** `pptx_to_svg.py`.
- Optional: EMF/WMF assets shell out to ImageMagick (`magick`) if present, and
  degrade gracefully when it is absent — not a hard dependency.
- Do **not** edit the Python: internal imports are relative and the CLI does
  `sys.path.insert(0, <script dir>)` to resolve both the package and the
  helper from its own directory.

Charts / SmartArt fall back to the PowerPoint-baked preview bitmap when
present, otherwise a labelled placeholder box.
