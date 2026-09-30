# Cognitive Mirror

Type a thought and it becomes a vector. A matrix you choose turns that vector into its mirror image, and both are drawn in a 3D space you can orbit.

This is a rebuild of the Gemini-made "Active Cognitive Mirror Simulation Engine". It is still one HTML file with no dependencies, and it runs offline.

## Run it

| Where | How |
| --- | --- |
| Laptop | Double-click `index.html`. For offline install, serve the folder instead: `npx serve cognitive-mirror` or `python -m http.server -d cognitive-mirror`. |
| iPhone | Open the hosted URL in Safari, then Share → **Add to Home Screen**. It opens full-screen and works offline after the first visit. |
| Hosting | Any static host works. With GitHub Pages on this repo it is served at `/Awab-M/cognitive-mirror/`. |

## The model

| Axis | Meaning | Source |
| --- | --- | --- |
| X | Valence, −1 to 1 | Positive/negative word lexicon with negation (“not good”) and `!` intensity, squashed with tanh |
| Y | Complexity, 0 to 1 | Average word length and lexical diversity |
| Z | Entropy, 0 to 1 | Shannon entropy of the characters, H / 4.7 bits |
| W | Density, 0 to 1 | log₁₀(length + 1) / 3, drawn as the dot size |

`V_mirror = M · V_human + σ·noise`. The noise is seeded by the text, so the same text always lands in the same place.

| Operator | M |
| --- | --- |
| Inversion | −γI |
| Householder reflection | γ(I − 2nnᵀ), n = (cos θ, sin θ, 0) |
| Rotation | γR(θ) about (1,1,1)/√3 (Rodrigues) |
| Softmax attention | −3γ · diag(softmax(αV)), which depends on the input |

The inspector shows the live matrix and its determinant.

## What changed from the Gemini build

| Problem in the original | Fix |
| --- | --- |
| `ctx.scale(dpr)` ran again on every resize, so the drawing grew each time | `setTransform` on resize, driven by a `ResizeObserver` |
| Mouse-only camera, so it did not work on iPhone | Pointer events with drag, pinch, inertia, double-tap reset, wheel and keyboard |
| “Valence” counted letters, so almost every input read +1 | Lexicon sentiment with negation |
| Entropy (0–4.5) and gain could put vectors far outside the ±2 grid | All axes normalised to a unit cube with perspective projection |
| “SO(3) rotation” rotated only in the XY plane, and the Householder reflection was 2D | Real 3D Rodrigues rotation and a 3×3 Householder |
| Noise re-rolled on every slider move and the eigenvalue was always shown as −γ | Seeded noise and a true determinant for each operator |
| Presets did not set α, had no selected state, and Reset left α stale | One state model: presets select, edits drop to Custom, Reset restores everything |
| HUD said “Z: Density”, W was computed but never shown, cosine showed −1 for empty input | Labels corrected, W drives the dot size, empty input shows “—” |
| Tailwind CDN, Font Awesome and Google Fonts on every load (and a missing `fa-mirror` icon) | No external requests. Uses the system font, so SF Pro on Apple devices |
| `h-screen` and `select-none` broke iOS viewport height and text selection | `svh` units and safe-area insets, plus a 17px textarea so iOS doesn't zoom on focus |
| Kept drawing while hidden | Drawing pauses when the stage is off-screen or the tab is hidden, and it respects Reduced Motion |

## Files

`index.html` is the app. `manifest.webmanifest`, `sw.js` and the icons make it installable. Lines marked `<!--shell-->` are the document wrapper. Stripping them gives the embeddable version:

```sh
grep -v -- '<!--shell-->' cognitive-mirror/index.html > mirror-embed.html
```
