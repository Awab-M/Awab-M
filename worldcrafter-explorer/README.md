# WorldCrafter Explorer

A local app for exploring generated worlds with
[WorldCrafter](https://github.com/TencentARC/WorldCrafter) (Tencent ARC, 2026) without a GPU.
You plan a camera route with the keyboard; the free
[WorldCrafter Space](https://huggingface.co/spaces/Drexubery/worldcrafter-demo) on Hugging Face renders it;
the video lands in a gallery on your computer.

WorldCrafter needs ~140 GB of weights and an H200-class GPU, so it cannot run on a normal laptop.
This app runs on your machine and sends each render to the Space.

## Start

Needs [Node.js](https://nodejs.org) 18 or newer.

- **Windows:** double-click `start.bat`. It installs the one dependency the first time and opens the app.
- **Anywhere:** `npm install` then `npm start`, and open <http://localhost:7788>.

Options: `node server.js --port 7788 --data ./data --space Drexubery/worldcrafter-demo --open`.

## Hugging Face token (recommended)

The Space rations free GPU time per user. Without a token you share a small anonymous allowance
that runs out fast (you'll see "ZeroGPU quota exceeded"). With a free account you get your own:

1. Create a **Read** token at <https://huggingface.co/settings/tokens>.
2. Click the token pill (top right) and paste it.

The token is stored only in `data/settings.json` and sent only to Hugging Face. The app also picks up
`HF_TOKEN` or a `hf auth login` session automatically.

## Using it

1. **Scene:** pick an official example, or drop/paste a start image (cropped to 5:3 because the model
   stretches everything to 640×384), or switch to *Text → video*. Write a prompt.
2. **Route:** each key press adds one 33-frame chunk (about 2 s of video). Keys match the official demo:

   | Key | Move | Key | Move |
   | --- | --- | --- | --- |
   | W / S | forward / back | ← / → | turn left / right |
   | A / D | left / right | ↑ / ↓ | look up / down |
   | Q / E | up / down | Shift + key | merge into the previous chunk |
   | Backspace | undo | Ctrl + Enter | render |

   *Orbit* makes the arrows circle a point in front of the camera. *Return to start* retraces the
   route, which is where WorldCrafter's 3D memory shows. The map is top-down (forward is up).
   The *Action script* box takes the same syntax as the official repo (`forward1x2`, `yl30`,
   `f2&yl45`, `reverse2`, `@orbit_radius 3`, …).
3. **Render:** watch the queue position and progress. Finished videos go to the gallery.
   **Continue from last frame** starts the next leg where the video ended; **Play journey** plays
   the legs back to back.

## Limits

- **Max 6 chunks per render** (about 12 s). Chunks past that are shown struck through and won't render.
- **Memory lasts one render.** WorldCrafter remembers the scene within a render. A continued leg only
  sees the last frame, so it won't remember what was behind you.
- **GPU quota.** Each render reserves 41–117 s of GPU time from your quota (shown before you render;
  the formula is the Space's own).
- **Shared Space.** Other people use it too, so you may queue. If the owner pauses or changes it,
  renders stop working. `--space` can point at a duplicate.

## How it works

- `server.js`, `src/`: a small Node server bound to `127.0.0.1`. It talks to the Space through the
  official `@gradio/client`, streams progress to the page, and saves `data/runs/<id>/`
  (`video.mp4`, `input.*`, `meta.json`).
- `public/actions.js`: WorldCrafter's camera-action grammar and trajectory builder, ported from
  `worldcrafter/camera.py`. The browser uses it for the map and validation, and the server uses it
  to reject bad routes before they cost GPU time. It matches the Python reference to within 1e-14
  on thousands of random scripts.
- `public/`: plain HTML/CSS/JS, no build step.

## Tests

```bash
npm test
```

This runs the golden trajectory checks against output from the official code
(`test/fixtures/golden.json`) plus API tests with a fake Space. To regenerate the fixture from a
WorldCrafter checkout: `python tools/make_golden.py /path/to/WorldCrafter` (needs numpy).

## License note

WorldCrafter's code and weights are licensed for **academic, non-commercial use only**
(see the upstream `LICENSE.txt`). This app doesn't bundle the model, its code or example media.
It calls the public Space and downloads the example scenes on demand.
