# Living Stills

Bring a still night illustration to life. Every lamp, window, lantern and reflection in a generated painting becomes a light you can switch, dim, recolour and animate. A torch follows your cursor, a light travels down a street, the city wakes window by window, and a train loops across a viaduct with its own glow.

Everything runs in the browser. Your OpenRouter key stays in your browser and images are requested straight from OpenRouter.

**Live site:** https://cybercryptixcoder.github.io/living-stills/

## How it works

Light adds up. Take the same picture with every light on and with every light off: the difference is the light itself, and any mix of lights is the dark picture plus a share of that difference. The renderer composites this in linear light on the GPU every frame (the same arithmetic LightLab uses to build its training pairs, [Magar et al. 2025](https://arxiv.org/abs/2505.09608)).

The open question is how to get each light's share. Living Stills does it four ways, so you can compare:

| Method | Images | Cost with FLUX 3 Klein | What you get |
| --- | --- | --- | --- |
| **Split** | 2 (lit + unlit) | about 1.8¢ | Lights found automatically in the difference: every window and lamp becomes its own light (up to 240). Glow is shared between lights by distance and brightness; reflections follow the light above them. |
| **Per-light edits** | 2 + 1 per light | about 0.8¢ per light | The model is shown a crop centred on one light, plus the same crop lit as a reference, and switches on only that light. The way its light falls is painted, not estimated. |
| **Moving layer** | 4 | about 3.6¢ | The scene without the moving thing, lit and unlit. The difference cuts it out with its own glow, so it loops forever. |
| **Every frame** | 4 + frames × lights | 12 more images for 4 positions × 3 lights | The brute-force grid: every light painted again at every position of the moving thing. Kept to compare. |

Precise targeting without masks or paid inpainting:

- **Split** never asks the model about individual lights. It finds them in the pixels: bright cores in the lit−unlit difference, rows of windows split at the dark gaps between them, compact lamps kept whole. Every light gets an id and a soft area of influence, so the 37th window of a building is addressable as precisely as a lone street lamp.
- **Per-light edits** target with geometry. The crop is centred on the light's brightness-weighted centre, so "the light at the exact centre" is unambiguous. It is padded past the picture's edge when needed and pasted back with feathered edges. The result is confined to the area the analysis gave that light, so a lamp the model invents elsewhere in the crop cannot leak in.

## Using it

- **Switch.** Click a light to switch it. Right-click (or long-press on touch) for brightness, colour and a real per-light edit.
- **Torch, Paint, Trail.** Lights follow the cursor, are painted on with a brush, or wake behind the cursor and fade.
- **Route.** Drag a path; a light travels along it, like a car down a street.
- **Sweep, Breathe, Flicker, Dusk.** A wave across the scene (click for ripples), slow breathing, failing bulbs, and a night where lights come on one by one.
- **Channels.** One fader per group of lights, plus the moving element and a master. Click a fader's letter to switch the whole group.
- **Picture.** Moonlight (everything that isn't a lamp), exposure, glow, haze, warmth, grain.
- **Switching.** Filament (warm-up and cool-down), Instant, or Neon (stutters on).
- **Capture.** Save a still or record a clip of just the picture (MP4 where the browser supports it, otherwise WebM).
- **Keys.** `1`–`9` modes, `A`/`O` all on/off, `L` show lights, `Space` motion, `[` `]` radius, `H` hide the interface, `N` new scene, `S` scenes, `?` help.

If the model removes lamps instead of switching them off, use **Repaint the dark version** (one image). **Lights and reflections** sets where water or wet ground begins, so lamps and their reflections switch together.

## Choosing the model

Researched and tested on 28 October 2026 against OpenRouter's image models. The pipeline needs edits that keep every pixel in place, because the light is the difference between two images.

| Model | Price per image | Edits stay aligned? | Notes |
| --- | --- | --- | --- |
| **FLUX 3 Image Klein** (used) | $0.008 at 768, $0.009 at 1K | Yes | Artificial Analysis rank 21 for text-to-image and 27 for editing. Open weights, 5.6B parameters. |
| Recraft V4.1 Flash | $0.007 | No editing | Cheapest generator, but cannot make the unlit version. |
| GPT Image 1 Mini, low quality | $0.0034 to generate, $0.0072 to edit | No | Tested: the lights-off edit redrew the whole scene (moved the bridge, added a moon). |
| FLUX.2 Klein 4B | $0.014 per megapixel | Yes | Weaker on the leaderboards and not cheaper at 1K. |
| Seedream 5.0 Flash, Qwen Image 2.1 Turbo | $0.018 | Not tested | About twice the price. |

That puts the per-image cost at about $8–9 per 1,000 on OpenRouter. Nothing on OpenRouter at $1–2 per 1,000 produced usable edits. The bigger saving is the method: a split scene is 2 images however many lights it has, so 240 controllable lights cost 1.8¢.

Sources: [OpenRouter image models](https://openrouter.ai/black-forest-labs/flux-3-image-klein), [Artificial Analysis text-to-image](https://artificialanalysis.ai/image/leaderboard/text-to-image), [Artificial Analysis editing](https://artificialanalysis.ai/image/leaderboard/editing).

## Run it locally

```bash
npm install
npm run dev          # http://localhost:5173
npm run build        # static site in dist/
npm test             # unit tests for the analysis
```

Add your OpenRouter key in Settings (the key icon), then **New scene**.

### End-to-end tests

`scripts/e2e.mjs` drives the real interface in Chromium with real OpenRouter calls. It needs Playwright installed (`npm i -D playwright && npx playwright install chromium`) and the dev server running.

```bash
OPENROUTER_KEY=sk-or-... node scripts/e2e.mjs --flow viaduct --profile .e2e   # moving layer, 4 images
OPENROUTER_KEY=sk-or-... node scripts/e2e.mjs --flow city                     # split, 2 images
OPENROUTER_KEY=sk-or-... node scripts/e2e.mjs --flow refine --scene "Rain Alley"   # 5 per-light edits
OPENROUTER_KEY=sk-or-... node scripts/e2e.mjs --flow grid --frames 4          # every frame
node scripts/e2e.mjs --flow play                                              # free: every example, every mode
node scripts/e2e.mjs --flow viaduct --mock                                    # free plumbing check
```

Each flow checks the result in pixels: switching all lights changes the composite, the torch lights only the area under the cursor, the moving element travels, and per-light edits differ from the estimate. `--bake <name>` exports the scene into `public/scenes/<name>` as an example. The four examples were made this way.

## Layout

```
src/core/analysis.ts       light finding, soft assignment, crop edits, moving-element cutout (pure, tested)
src/core/sceneAnalysis.ts  scene document -> GPU layers, per method
src/core/worker.ts         runs the analysis off the main thread
src/core/pipeline.ts       generation flows: new scene, per-light edits, repaint, every frame
src/core/openrouter.ts     image API client (browser fetch)
src/render/                WebGL2 compositor: linear-light layers, glow pyramid, backdrop, tone and grain
src/play/engine.ts         light levels each frame: modes, faders, colours, switching feel
src/ui/                    stage, console, sheets
public/scenes/             the examples (images + scene.json)
scripts/e2e.mjs            live end-to-end tests through the UI
```

## Limits

- Light is estimated where two lights overlap. Per-light edits fix that for the lights that matter.
- A moving element slides sideways along a straight line, so pick scenes where it travels side-on (a train on a bridge, a car on a flat road).
- The lit and unlit images come from an editing model, so they can disagree. Repainting the dark version usually fixes it.
