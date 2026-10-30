# Living Stills

Bring a still picture to life. Every lamp, window, sign and glowing thing in a generated picture, a photo or a drawing becomes a light you can switch, dim, recolour and animate. Click a light to adjust it, start a preset show, let the lights follow music, or describe a sequence in words and let the director play it.

Everything runs in the browser. Your keys stay in your browser: images are requested straight from OpenRouter, and director requests go to Luminal through a small relay (see below).

**Live site:** https://cybercryptixcoder.github.io/living-stills/

## 3D: Gaussian splats you can look around (this branch)

*Make it 3D* turns any scene into a small 3D space: move the cursor over the picture and the view turns with it (or drag, or let it sway). The lights keep working in 3D: switch, dim, recolour, presets, the director and music all show up in the 3D view at once, and the brightest lights glow at their real place in space, hidden by whatever is nearer.

How it is built (free, all in the browser):

1. **Depth.** Depth Anything V2 runs in the browser through transformers.js (WebGPU, or WebAssembly without a GPU). A quick pass with the small model (~27 MB, downloaded once) shows the 3D view in seconds; a detailed pass with the base model (~100 MB) replaces it a minute or two later. Both are snapped to the picture's own edges with a guided filter (He, Sun and Tang 2010), so outlines in depth match outlines in the picture, and "flying pixels" on outlines are snapped to the nearer side.
2. **Splats.** Every pixel becomes a Gaussian splat placed on its camera ray at its depth, the lifting Flash3D (Szymanowicz et al. 2024) learns from monocular depth. A sparse second layer sits behind depth edges and fills what a moving camera uncovers.
3. **Rendering.** Surface splatting (Zwicker et al. 2001): a visibility pass, a Gaussian-weighted accumulation within a depth tolerance, and a normalisation, so no sorting is needed. Where splats spread thin, colour comes from coarser levels (pull-push).
4. **Light in 3D.** Splats take their colour from the relit picture every frame. The brightest lights also add glow sprites at their 3D positions and soft highlights on broad surfaces (normals from the smoothed depth), which slide as the camera moves.

The depth map is kept with the scene (and with the examples), so it is measured once.

## How it works: two images, many lights

Light adds up. Take the same picture once with its lights on and once with them off. The difference is the light itself, and any mix of lights is the dark picture plus a share of that difference:

    picture = lights-off + Σ (level of light i × share of light i)

The app finds each light in the difference (bright cores: a window, a lamp, a glowing sign), numbers it, and gives every pixel a share of the nearest lights by distance and brightness. Changing a light is then just changing a number, so the GPU recomposites the picture every frame. Window City has 240 separately controllable lights from 2 images.

On white paper, "light" can also tint or darken (a red glow on paper removes blue), so the difference is kept signed when the picture calls for it.

### How many images a scene needs

| Case | Images | Why |
| --- | --- | --- |
| Ordinary scene, in one go | 2 | Lights on, lights off. |
| Picture first, lights placed by hand | 2 | The picture is the lights-off version; one edit switches your lights on. |
| An everyday (daylit) picture | +1 | A dark version is made first so lights stand out; the original becomes a Daylight slider. |
| Lights that wash the same wall | +1 per light, optional | The model repaints one light at a time, so overlapping glows are painted, not estimated. Rain Alley shows this (2 + 5 = 7 images). |
| Something moving | +2 | The scene without it, lit and unlit, so it can be cut out and loop. |
| A photo, recreated first | +1 | The image model redraws it (identically, or with your changes). |

## Making a scene

**New scene** offers three ways in. Nothing is styled for you: write any medium, mood or subject.

- **In one go.** Describe the picture and, optionally, its lights ("the shop sign in pink neon, upstairs windows amber"). 2 images.
- **Picture, then lights.** The picture is made first. Then click where the lights go, say what each one is ("only the rubber of the front tyre"), pick a colour, and press *Light it up*. If a Luminal key is set, DeepSeek first reads the picture with your numbered markers on it and works out exactly which object or part each marker means and where it ends; that description goes to the image model, and the found lights are grouped by marker. Without it, your notes go as written, with each marker's position.
- **From a photo.** A photo, a scan of your artwork, a picture of a real place. Optionally have it recreated first (identically, or with changes such as "as a pen sketch" or "at night"). Then keep just the picture, place the lights, or describe them. A picture whose lights are already on (a night photo, a painting with stars) gets a lights-off version made instead.

## Using it

- **Click a light.** Its panel opens: switch, brightness, colour and a behaviour (steady, breathe, flicker, follow music). *This light* or *Its group* chooses what you control. Shift-click or Shift-drag picks several; Alt-click switches one quickly. Hover a light to see its name and its group.
- **Effects** (how lights respond to you): Select, Torch, Brush, Trail, Path (draw a route; a light travels along it, like a car down a street), Wave, Breathe, Flicker, Music.
- **Presets** (ready-made shows): Dusk, Dawn, Wave, Heartbeat, Power cut, Twinkle, Party, All on, plus the shows you save from the director.
- **Director.** Describe a sequence: "the windows on the left flicker four times together, then the sign sparks on, then everything breathes in amber". DeepSeek writes it as a show (JSON steps: set, fade, flicker, pulse, chase, scatter, sparkle, strobe, spark, colour, music) aimed at named groups of lights, and it plays at once. Refine it ("slower", "in cyan") and save it as a preset.
- **Music.** The Music effect listens to your microphone or to a browser tab's sound (Chrome: pick a tab and tick *Share tab audio*). Lights pulse together, map bass-to-treble from bottom to top, spread as a spectrum from left to right, or hop group to group on each beat.
- **Look.** All lights, unlit areas, daylight (when the scene has it), glow, haze, warmth, exposure, grain, switching feel (bulb, instant, neon), markers.
- **Capture.** Save a still or record a clip of just the picture.
- **Keys.** `1`–`9` effects, `P` presets, `D` director, `U` dusk, `A`/`O` all on/off, `Space` motion, `[` `]` torch size, `H` hide the interface, `N` new scene, `S` scenes, `?` help, `Esc` close.

## Keys and the Luminal relay

- **OpenRouter** (images): Settings → OpenRouter key.
- **Luminal** (director, picture reading; DeepSeek V4.1 Flash): Settings → Luminal key.

Luminal does not answer calls made from a web page (no CORS), so the browser reaches it through a relay that forwards the request and adds the missing permission. Your key travels with each request and is not stored.

- `npm run dev` and `npm run serve` include the relay at `/luminal`, nothing to set.
- For the published site, deploy the relay once to a free Cloudflare account and put its URL in Settings → Relay URL:

  [![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/cybercryptixcoder/living-stills/tree/main/relay)

  Or by hand: Workers & Pages → Create → Worker → paste [`relay/worker.js`](relay/worker.js) → Deploy.

## Choosing the image model

Researched and tested on 28 October 2026 against OpenRouter's image models. The pipeline needs edits that keep every pixel in place, because the light is the difference between two images.

| Model | Price per image | Edits stay aligned? | Notes |
| --- | --- | --- | --- |
| **FLUX 3 Image Klein** (used) | $0.008 at 768, $0.009 at 1K | Yes | Artificial Analysis rank 21 for text-to-image and 27 for editing. Open weights, 5.6B parameters. |
| Recraft V4.1 Flash | $0.007 | No editing | Cheapest generator, but cannot make the unlit version. |
| GPT Image 1 Mini, low quality | $0.0034 to generate, $0.0072 to edit | No | Tested: the lights-off edit redrew the whole scene. |
| FLUX.2 Klein 4B | $0.014 per megapixel | Yes | Weaker on the leaderboards and not cheaper at 1K. |
| Seedream 5.0 Flash, Qwen Image 2.1 Turbo | $0.018 | Not tested | About twice the price. |

About $8–9 per 1,000 images on OpenRouter; nothing at $1–2 per 1,000 produced usable edits. The method is the bigger saving: a scene is 2 images however many lights it has.

## Run it locally

```bash
npm install
npm run dev          # http://localhost:5173, with the Luminal relay
npm run build        # static site in dist/
npm run serve        # serves dist/ with the relay on http://localhost:4173
npm test             # unit tests for the analysis
```

### End-to-end tests

`scripts/e2e.mjs` drives the real interface in Chromium with real OpenRouter and Luminal calls (Playwright).

```bash
node scripts/e2e.mjs --flow play                                    # free: examples, light panel, effects, presets, music
LUMINAL_KEY=lum_... node scripts/e2e.mjs --flow director            # director: labels, a show, a refinement, save
OPENROUTER_KEY=sk-or-... node scripts/e2e.mjs --flow create --prompt "..." --lighting "..."
OPENROUTER_KEY=... LUMINAL_KEY=... node scripts/e2e.mjs --flow base --profile .e2e --prompt "..."     # picture first
OPENROUTER_KEY=... LUMINAL_KEY=... node scripts/e2e.mjs --flow lightup --profile .e2e --markers "0.4,0.3,the sign,#ff3b30;0.7,0.6,the window"
OPENROUTER_KEY=... node scripts/e2e.mjs --flow photo --file photo.jpg --then describe --kind lit --lighting "the stars and windows"
```

Each flow checks the result in pixels (switching lights changes the composite, the light panel switches its group, the torch lights only the area under the cursor, presets and music move the lights). `--bake <name>` exports the scene into `public/scenes/<name>` as an example.

## Layout

```
src/core/analysis.ts       light finding (additive or signed), soft assignment, crop edits, moving-element cutout
src/core/sceneAnalysis.ts  scene document -> GPU layers; placed lights become groups
src/core/pipeline.ts       image flows: one go, picture then lights, from a photo, repaint, per-light edits
src/core/agents.ts         DeepSeek: names light groups, plans placed lights, directs shows
src/core/luminal.ts        Luminal client (streaming, retries) through the relay
src/core/openrouter.ts     image API client (browser fetch)
src/play/engine.ts         light levels each frame: effects, shows, per-light behaviours, music
src/play/show.ts           the show format, its player and validator
src/play/audio.ts          microphone / tab audio -> bands and beats
src/render/                WebGL2 compositor: linear-light layers, daylight mix, glow, tone and grain
src/ui/                    stage, light panel, dock and menus, director, composer, studio
relay/worker.js            the Luminal relay (Cloudflare Worker; also used by the dev server)
```

## Limits

- Where two lights wash the same surface, each one's share is estimated. Repainting chosen lights fixes it for those lights.
- A moving element slides sideways along a straight line, so pick scenes where it travels side-on.
- The image model redraws a little on every edit; the analysis treats small changes as noise, and in hand-placed scenes only change near your markers counts as light.
- The director needs a Luminal key, and on the published site a relay.
