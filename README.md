# WigglePaint 🎨🦴🎬

**Live App:** [https://ahpah-dev.github.io/wigglepaint/](https://ahpah-dev.github.io/wigglepaint/)

A lightweight, zero-dependency MS-Paint style creative studio with **super easy 2D rigging and automatic tweening** right in the browser.

## Features
- **1. Draw (Modern MS-Paint Soul + Real-Time Line Stabilizer):** Toggleable **✨ Auto Smooth** with adjustable strength (`10%–100%`) that smoothly filters out laptop trackpad or mouse jitter with **zero drawing lag** (predictive lead-ahead filtering eliminates delay while keeping strokes clean and jitter-free)—plus **Rectangle Select & Freeform Lasso with Click-to-Select Drawn Elements**, **Copy (`Ctrl+C`)**, **Paste (`Ctrl+V`)**, **Delete (`Del`)**, halo-free Paint Bucket flood fill, Airbrush Spray, Transparency Eraser, Lasso Cut ("Split to New Part"), Shapes, Text, Color Picker, and dual Left/Right-click color swatches.
- **Interactive Zoom In/Out:** Dedicated Zoom controls (`+`, `−`, `100%`, `Fit`) plus `Ctrl+Wheel` and `Ctrl + / - / 0` shortcuts for precision drawing and detail work.
- **2. Rig (Zero-Warp Puppet Rigging):** Click & drag directly over your flat drawing to add connected bones—or drop a silhouette-scanning 1-click **Person**, **Pet/Dino**, or **Bendy Spine** rig. Automatically segments your painting into crisp, zero-warp rigid puppet pieces with seamless rounded joint hinges and smart limb Z-ordering.
- **3. Animate (Instant Tweening & IK):** Drag any joint dot for Smart Inverse Kinematics (IK), rotate bones directly, or squash & stretch unrigged drawings. Add poses on the timeline filmstrip for instant smooth, springy, bouncy, or elastic tweening with Onion Skinning and Seamless Looping.
- **Built-in Export:** Export looping **Animated GIFs** (self-contained GIF89a encoder), **60fps WebM Video**, **PNG snapshots**, or save/load `.wiggle.json` projects.

## Shortcuts
| Key | Action |
|---|---|
| `1` / `2` / `3` | Switch between **Draw**, **Rig**, and **Animate** |
| `Space` | Play / Pause animation |
| `B`, `P`, `G`, `A`, `E`, `S`, `Q`, `L`, `R`, `O`, `T`, `I` | Select Paint tools (`S` Box Select, `Q` Lasso) |
| `Ctrl+C` / `Ctrl+V` | Copy / Paste active selection |
| `Delete` / `Backspace` | Delete active selection |
| `Ctrl +` / `Ctrl -` / `Ctrl 0` | Zoom In / Out / Reset Zoom to 100% |
| `X` | Swap Primary & Secondary colors |
| `[` / `]` | Decrease / Increase brush size |
| `Ctrl+Z` / `Ctrl+Y` | Undo / Redo |
