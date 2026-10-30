# Living Stills: handoff

The single source of truth for picking this project up. Keep it current: update it whenever something
is decided, done, tried and dropped, or planned. Last updated: 30 Oct 2026, ~04:00 New York time.

---

## 1. What this is

**Living Stills** takes a still picture (generated, a photo, a drawing) and brings it to life: every lamp,
window, sign and glowing thing becomes a light you can switch, dim, recolour and animate, and the picture
can be turned into a small 3D space (Gaussian splats) you can look around, with the lights still working.

The user's overarching theme: **take something static and put life into it.** Surreal, magical, but the
3D should look *realistic* (not hazy, not bent, textures captured well).

- Repo: `github.com/cybercryptixcoder/living-stills` (public).
- Live site (branch `main`): https://cybercryptixcoder.github.io/living-stills/
- 3D preview (branch `splat`): https://cybercryptixcoder.github.io/living-stills/splat/
- Earlier planning doc (Gaussian-splat worlds, light-switch illustrations, 1970s–80s Tokyo neighbourhood
  world): https://claude.ai/artifact/FQvi1CRDi5TaKbTfgv3hrr

## 2. Hard rules from the user (do not break)

- **Commits and pushes as `cybercryptixcoder <official.shreyas28@gmail.com>`, never Claude's identity, and
  no `Co-Authored-By: Claude` or similar lines.** ("I don't want any Claude pushes there.") Local git config
  in the worktrees is already set; check `git log -1 --format='%an <%ae>'`.
- **Never commit keys.** OpenRouter and Luminal keys were given in chat (temporary; the user rotates them).
  They live only in a scratchpad env file outside the repo. Grep before committing.
- **Image spend cap:** the user raised it to **$1 total** for this round (originally $0.50). Text (Luminal /
  DeepSeek) is unlimited. Check spend with `GET https://openrouter.ai/api/v1/key` (field `usage`).
  Baseline at the start of this round: `usage = 0.4887`. At ~04:00 it was ~0.64 (≈15¢ this round) plus a
  3D-space run in progress (≤5.4¢).
- **Images only from OpenRouter; all text/LLM from Luminal (DeepSeek V4.1 Flash).** Do not use OpenRouter
  for text.
- **Testing means live, end to end, with real model calls**, through the real UI (Playwright). Mocks are only
  for free plumbing checks.
- **UI/UX is as important as the functionality**: pretty, uncluttered, everything explained, nothing that
  needs a mental map (no "channel A–H" faders).
- **Commit and push often** so progress is visible on the live site (sessions can end abruptly).
- **Status updates to the user every 10–15 minutes** during long work (what was done in that period).
- Prefer breadth first (a working version of everything), then iterate on quality.
- Mid-task messages from the user add work; they never cancel earlier requests.

## 3. Everything the user has asked for (chronological), with status

Legend: ✅ done and tested live · 🟡 done, needs more work/testing · ⏳ not started

### Round 1 (earlier session, already shipped)
- ✅ Research cheap image models ($1–2 per 1,000 ideal, $5–8 max). Result: FLUX 3 Image Klein on OpenRouter
  ($0.008–0.009/image) is the cheapest whose edits stay pixel-aligned; GPT Image 1 Mini redraws the scene on
  edits (tested, unusable); nothing at $1–2/1,000 works. The method (2 images per scene) is the real saving.
- ✅ Light-switchable illustrations: lit/unlit pair → every light controllable; per-light real edits; moving
  element (train) as a looping layer; modes (torch, route = a light travelling a path, etc.).
- ✅ Published under the user's identity; GitHub Pages enabled.

### Round 2 (this session)
1. ✅ Check the user's redesign branch (`redesign/runview-frontend`, RunView-inspired palette/type), fix and
   merge to main. (Merged fast-forward; it worked; its visual glitches were fixed in the rebuild.)
2. ✅ **Rework the UI/UX**: too many features, unclear purpose. Keep the features but conceal them better and
   describe each. Inspiration: the redesign (RunView) and **Avy** (`github.com/cybercryptixcoder/Avy`:
   cream paper, ink outlines, offset shadows, Instrument Serif italic, Space Mono, coloured pills).
   - ✅ **Click a light → a panel**: switch, brightness slider, colour, behaviour; "this light / its group /
     picked"; no labels like "group A". Hover shows the light's name and dots its group.
   - ✅ Presets in one menu; ways of lighting (torch, follow, wave…) in an Effects menu; every item described.
   - ✅ Scene fixes/extras put away in a Scene menu; Look menu explains every slider.
3. ✅ **Remove the style bias**: no preset styles; free prompt for the picture + a separate box for how the
   lighting should look. Any medium (pen sketch with ruled perspective, photo, pixel art…).
4. ✅ **Two-stage creation**: make the picture first, then place numbered markers where lights go, with notes
   and colours ("only the rubber of the tyre"); context-aware (DeepSeek vision reads the picture with the
   markers and resolves each to an exact object + box). Base picture either *is* the dark version (2 images)
   or is an everyday picture (a dark version is made, 3 images; original becomes a Daylight slider).
   Single-go remains an option.
5. ✅ Remove the "every frame" (n×m) grid feature. (Old scenes open as moving-layer scenes.)
6. ✅ Answer: how 2 images give 20+ lights; why Rain Alley took 7 images (2 + 5 optional per-light edits);
   when 2 suffice vs more. (Answered in chat; also in README "How many images a scene needs" and Help.)
7. ✅ **Director agent** (Luminal/DeepSeek): describe a sequence in words ("these lights sync, flicker 4
   times, then the light behind X sparks on"); the agent writes a show (JSON timeline) and plays it; refine
   in follow-ups; save as presets. The agent sees named light groups (vision labels).
8. ✅ **Music-reactive lighting**: microphone or tab/system audio; several mappings.
9. ✅ New, non-gloomy examples in different media (photo-style bookshop, pen sketch, Starry Night from an
   artwork, pixel arcade, marker-sketch coupe with glowing tyre rubber, hotel from a real photo; on `splat`
   also a Tokyo izakaya and a snowy cabin).
10. ✅ **From a photo** (user's later message): photo/artwork/real place → optionally recreate with the
    image model (identical or with changes) → same pipeline; choose the extent: just the picture / place
    the lights / describe the lights (and on `splat`, "also make it 3D").
11. ✅ **Phones**: "Take a photo" opens the camera (`<input capture>`), no in-app camera UI; upload also works.
12. 🟡 **Gaussian splatting, on its own branch `splat`** (do not merge into main unless the user says so):
    - ✅ **Parallax** (single picture): splats from in-browser depth, lighting-aware, glow in 3D, highlights.
    - ✅ Quality pass: one splat per pixel on GPU, progressive detail (quick small model → detailed base
      model), guided-filter edge snapping, flying-pixel removal, no artificial speckle, pull-push hole fill,
      background layer behind depth edges.
    - 🟡 **3D space** (user's later message): the image model draws the same place from other angles around a
      centre point (4 views total), depth for each, merged into one space you can walk round. Separate
      feature/button from Parallax ("Parallax" and "3D space"), same branch. Implemented; first live run on
      the Tokyo izakaya was in progress at handoff time — check `scratch/space-tokyo.log` /
      `test-results/space-*.png` in the `ls-splat` worktree, judge the quality honestly, iterate.
    - 🟡 **Two variants of the 3D space** (user, 03:54): (1) *walk round it*: camera circles the centre facing
      inwards; (2) *look around from here*: camera stays put and turns facing outwards (a panorama). Only the
      prompts and the geometry differ (`mode: 'around' | 'panorama'` in `planOrbit`, `orbitViewPrompt`,
      `makeOrbit`, `buildEnv`, `alignViews`, `EnvCamera.update`). Both implemented; panorama not yet tested live.
    - 🟡 Photometric alignment of the drawn views (`alignViews`: small scale/angle search against the nearest
      placed view; result kept in `doc.orbit.align`). Implemented, not yet judged visually.
    - ⏳ Research-driven quality upgrades (see §8).
13. ✅ Commit/push often; Pages publishes `main` at `/` and `splat` at `/splat/` (one workflow on both
    branches).
14. ✅ This handoff document (keep updating it).

### Things the user explicitly wants to see in the final report
- What was built, honest limits, test results, spend, links, and sources for research.

## 4. Architecture (code map)

Stack: React 19, zustand, Vite 8, WebGL2, Web Worker, idb-keyval, fflate, vitest, Playwright,
transformers.js (splat branch).

```
src/core/analysis.ts       light finding in the lit-unlit difference (additive, or signed for glows on paper),
                           soft assignment of pixels to lights, crop edits, moving-element cutout
src/core/sceneAnalysis.ts  scene doc -> GPU layers; markers become groups (markerFocus limits light to near
                           placed markers; lights go to the closest marker whose vision box holds them)
src/core/pipeline.ts       image flows: createScene (one go), createBase + lightUp (two stages), fromPhoto,
                           repaintOff, refineLights (per-light edits), makeOrbit (splat: views from around)
src/core/prompts.ts        all image prompts (neutral: no style added)
src/core/agents.ts         DeepSeek: labelZones (names light groups, set-of-marks), planMarkers (two-stage),
                           direct (director -> show JSON), planOrbit (splat: describes other views)
src/core/luminal.ts        Luminal client: streaming SSE, retries, reasoning_effort + max_tokens always;
                           relayUrl()/detectRelay()
src/core/openrouter.ts     image client (browser fetch; OpenRouter allows CORS)
src/play/engine.ts         per-light levels each frame: effects (modes), shows, per-light fx, music
src/play/show.ts           show format (set/fade/flicker/pulse/chase/scatter/sparkle/strobe/spark/color/music),
                           compile/evaluate/sanitize
src/play/presets.ts        built-in shows + saved ones (localStorage)
src/play/zones.ts          k-means light groups ("its group"), names, fingerprint for labels
src/play/audio.ts          mic / tab audio -> bands, beats
src/render/Renderer.ts     WebGL2 compositor (+ daylight mix, signed-light clamp; splat passes on `splat`)
src/ui/*                   Stage (canvas, picking, overlay), Inspector (light panel), Dock (menus), Director,
                           Sheets (composer, settings, help…), Studio (place the lights), TopBar
relay/worker.js            Luminal relay (Cloudflare Worker; also used by the dev server and scripts/serve.mjs)
scripts/e2e.mjs            live end-to-end tests (flows listed at its top)
scripts/serve.mjs          serves dist/ with the relay (npm run serve)
splat branch only:
src/splat/depth.ts         Depth Anything V2 small/base via transformers.js; guided-filter refineDepth; PNG io
src/splat/view.ts          View3D (parallax camera, projection), buildSplats (surface + behind-edge layer)
src/splat/env.ts           3D space: buildEnv (views placed on the orbit), EnvCamera, worldOf
src/splat/shaders.ts       splat shaders (visibility / accumulation / normalise / sprites / env)
```

Key data: `SceneDoc` (types.ts) — `images` (on, off, plateOn/plateOff, ambient, refine_*, depth,
orbit<angle>On/Off/Depth), `markers`, `labels`, `orbit`, `demo` (start3d, startSpace, order, startMode).

## 5. How the main ideas work (so you don't re-derive them)

- **2 images → many lights.** picture = off + Σ level_i × share_i × (on − off). Lights are bright cores in the
  difference; shares by distance/brightness (top-4 per pixel, ids/weights textures, light table texture).
- **Signed light**: if negative change is large (`looksSigned`), the delta stays signed (glows on white paper
  tint/darken). Composite clamps ≥ 0.
- **Two stages**: markers → DeepSeek vision plan (object + how + box per marker, set-of-marks image) →
  `lightUpPrompt` → Klein edit of the dark picture → analysis focused near markers → groups = markers.
- **Director**: system prompt = zones (named by vision) + the show format; `reasoning_effort: low`,
  `response_format: json_object`; sanitize; retry once with the error. ~4–5 s per answer.
- **Luminal relay**: Luminal sends no CORS headers, so browsers cannot call it. Dev server and `npm run serve`
  relay at `/luminal`; the published site needs the user to deploy `relay/worker.js` (Deploy-to-Cloudflare
  link in Settings/README) and paste its URL. **The user has not done this yet**; the director therefore works
  on the live site only after that. Do not route keys through public third-party CORS proxies.
- **Parallax (splat)**: depth (DA-V2 small then base, transformers.js, WebGPU or WASM) → guided filter to the
  picture's edges → one splat per pixel lifted on its ray (52° FOV pinhole; z ∈ [1, 1 + 4·strength] from
  normalised inverse depth) → surface splatting: visibility pass (discs), accumulation pass (Gaussian,
  depth tolerance), mipmap pull-push normalisation. Colours sampled from the relit composite every frame.
  Glow sprites at lights' 3D positions; specular from smoothed-depth normals (soft-limited).
- **3D space (splat)**: `planOrbit` (DeepSeek) describes views at 90/180/270° around the centre; `makeOrbit`
  draws each (refs: original + nearest finished view) and its lights-off version; depth per view; `buildEnv`
  scales each view so its centre is at the same distance R, rotates it onto the circle; renderer blends views
  by how close the camera is to each view's direction; view 0 relit per light, others mix on/off by litness.

## 6. Learnings and things that did NOT work (don't retry)

- GPT Image 1 Mini: lights-off edits redraw the scene → misaligned. Klein is the right model.
- The image model sometimes erases lamps instead of switching them off → "Redo the dark version" exists.
- Per-light edits without a lit reference invent new lamps → always send the lit crop as a second reference.
- Positive-only deltas fail on white paper (glows tint) → signed mode.
- Two-stage scenes without focusing produce "Other light" noise from redrawn hatching → `markerFocus`.
- Vision boxes overlap for adjacent windows → assign lights to the closest *clicked point* among boxes that
  contain them.
- Splats: hard-core visibility discs smaller than the spacing let the background show through (dots) → solid
  discs 1.5× spacing. Normals from raw depth throw random white glints → normals from smoothed depth and
  soft-limited specular. Pull-push via mipmaps fills thin areas.
- Shader gotchas: int uniform precision must match between vertex/fragment (`precision highp int`); image
  space is stored bottom-up, so image top maps to ndc y = −1 in splat passes.
- Testing gotchas: SwiftShader (no GPU) renders ~1–7 fps; screenshots need long timeouts; the app uses fewer
  splats when it detects software rendering (`renderer.software`), use `?splatStride=1` to force detail.
  IndexedDB is per origin: e2e `--profile` folders are tied to the port they were made on. Test against a
  *frozen* build (`vite build --outDir dist-test` + `ROOT=dist-test PORT=… node scripts/serve.mjs`), not the
  dev server (HMR reloads break runs). `pkill -f <pattern>` inside a command that contains the same pattern
  kills its own shell. The container has 2 cores: don't run two browser tests at once.
- Chromium's fake microphone is silent unless given a file: e2e passes `scripts/fixtures/beat.wav`.
- Depth Pro ONNX is 600 MB–3.8 GB (too heavy for a browser default). MoGe-2 ViT-B ONNX exists
  (`Ruicheng/moge-2-vitb-normal-onnx`, 419 MB, custom pre/post-processing) — candidate, see §8.

## 7. Testing and deploying

- `npm test` (unit), `npm run build`, `node scripts/e2e.mjs --flow …` (see the header of e2e.mjs). Keys via env:
  `OPENROUTER_KEY`, `LUMINAL_KEY`. Playwright is preinstalled (do not reinstall browsers).
- Last full results: main `play` flow across 9 examples passed except two torch checks whose threshold was
  then loosened; director, create, two-stage, photo flows passed live; splat `depth` flow passes on bookshop
  and Tokyo (parallax + lights in 3D).
- Pages workflow `.github/workflows/pages.yml` (same file on both branches) builds `main` at the root and
  `splat` at `/splat/` on every push to either.
- Worktrees on the machine: `living-stills` (main checkout), `ls-next` (branch `next`, fast-forwarded into
  main for each push), `ls-splat` (branch `splat`). To publish main: commit on `next`, then in
  `living-stills`: `git merge --ff-only next && git push origin main`. For splat: commit and push in
  `ls-splat`; merge main into splat when main changes.

## 8. What's next (agreed plan; stick to it)

1. **Judge the 3D space** (Tokyo run): if the other views are consistent enough, bake it into the Tokyo
   example (`--bake tokyo`) and make one more (bookshop or cabin). If they drift badly, keep the feature but
   improve: (a) photometric alignment of each view (search small scale/yaw offsets that best match the
   neighbouring view where they overlap), (b) generate at 60° steps (5–6 views) for more overlap, (c) stronger
   planner prompts. Keep Parallax as the reliable default.
2. Re-bake detailed depth for remaining examples (bookshop's depth is still the old quick one): run
   `scratch/bake3d.sh` in `ls-splat` (bookshop, starry, arcade, viaduct, car).
3. Quality research items, in order: MoGe-2 (metric point map + FOV + normals → less bending, sharper; via
   onnxruntime-web directly), depth-aware hole filling (prefer background in pull-push), optional
   image-model "background plate" (remove foreground → second layer) for real disocclusion fill, Apple SHARP
   (`apple/ml-sharp`: single image → 3DGS in under a second, needs a GPU; could run on the user's Mac and be
   imported as a .ply) and NVIDIA Lyra (video-diffusion → 3DGS; heavy GPU). Only free options for splatting.
4. Final report to the user (honest limits, spend, links, sources).

## 9. Example prompts used (for reproducing)

- Bookshop: "A photograph of a cosy independent bookshop interior in the late afternoon, tall wooden shelves
  full of books, a reading nook with two armchairs, plants, soft daylight through the big front window, shot on
  a 35mm lens" + lighting "warm string lights along the top of the shelves, a green banker's lamp on the
  counter, a paper floor lamp by the armchairs, a small pink neon OPEN sign in the window".
- Pen sketch café (two stages, 5 markers), Starry Night (OpenCV's `starry_night.jpg`, public domain;
  recreate + kind lit), pixel arcade, coupe (two stages; markers "only the rubber of the front/rear tyre"),
  hotel (OpenCV `building.jpg`, BSD; no recreate, kind ambient, 6 markers), Tokyo izakaya, snowy cabin —
  full prompts are in each `public/scenes/<id>/scene.json` (`prompt`, `lighting`, `markers`).
