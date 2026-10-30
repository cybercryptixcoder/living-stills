// The three things the text model (Luminal, DeepSeek) does for the app:
//  - reads the picture and names each zone of lights (so you and the director can say "the lanterns")
//  - plans a two-stage scene: what exactly is under each marker you placed, and how it should glow
//  - directs: turns a description of a light sequence into a show the engine plays

import { chat, parseJson, type ChatMessage } from './luminal';
import { sanitize, type Show } from '../play/show';
import type { Marker, SceneLabels } from './types';
import type { Zone } from '../play/zones';

export interface AgentCreds { key: string; relay: string; signal?: AbortSignal }

// ---------------------------------------------------------------- pictures for the vision model

async function toBitmap(b: Blob) {
  return createImageBitmap(b);
}

/** Draws the picture at ~1024 px with numbered marks on it ("set of marks" prompting). */
async function markedImage(img: Blob, draw: (ctx: CanvasRenderingContext2D, s: number) => void, maxW = 1024): Promise<string> {
  const bmp = await toBitmap(img);
  const s = Math.min(1, maxW / bmp.width);
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * s);
  c.height = Math.round(bmp.height * s);
  const ctx = c.getContext('2d')!;
  ctx.drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close();
  draw(ctx, s);
  return c.toDataURL('image/jpeg', 0.86);
}

function tag(ctx: CanvasRenderingContext2D, x: number, y: number, text: string, color = '#ff2d55') {
  ctx.font = 'bold 18px sans-serif';
  const w = ctx.measureText(text).width + 12;
  ctx.fillStyle = color;
  ctx.fillRect(x, y - 22, w, 22);
  ctx.fillStyle = '#fff';
  ctx.fillText(text, x + 6, y - 5);
}

// ---------------------------------------------------------------- zone labels

export async function labelZones(img: Blob, zones: Zone[], w: number, key: string, c: AgentCreds): Promise<SceneLabels> {
  const url = await markedImage(img, (ctx, s) => {
    ctx.lineWidth = 3;
    zones.forEach((z) => {
      const [x0, y0, x1, y1] = z.bbox.map((v) => v * s);
      ctx.strokeStyle = '#ff2d55';
      ctx.strokeRect(x0 - 3, y0 - 3, x1 - x0 + 6, y1 - y0 + 6);
      tag(ctx, Math.max(0, x0 - 3), Math.max(22, y0 - 3), String(z.n));
    });
  });
  const messages: ChatMessage[] = [{
    role: 'user',
    content: [
      { type: 'image_url', image_url: { url } },
      {
        type: 'text',
        text:
          `Each numbered red box marks a group of lights in this picture (${zones.length} groups). ` +
          'For each number, say what is lit there in 2 to 6 plain words, e.g. "paper lanterns over the door" or "upstairs apartment windows". ' +
          'Name the objects, not their position. Also describe the whole picture in one short sentence. ' +
          'Reply with JSON only: {"summary": "...", "zones": {"1": "...", "2": "..."}}',
      },
    ],
  }];
  const r = await chat({ ...c, messages, effort: 'none', maxTokens: 900, json: true, temperature: 0.3 });
  const j = parseJson<{ summary?: string; zones?: Record<string, string> }>(r.content);
  const out: Record<string, string> = {};
  for (const z of zones) {
    const v = j.zones?.[String(z.n)];
    if (typeof v === 'string' && v.trim()) out[String(z.n)] = v.trim().replace(/\.$/, '').slice(0, 60);
  }
  void w;
  return { summary: (j.summary ?? '').slice(0, 240), zones: out, key };
}

// ---------------------------------------------------------------- two-stage planning

export interface MarkerPlan { n: number; object: string; how: string; box?: [number, number, number, number] }

/** Reads the picture with your numbered markers on it and works out what each marker means. */
export async function planMarkers(img: Blob, markers: Marker[], w: number, h: number, prompt: string, lighting: string, c: AgentCreds): Promise<MarkerPlan[]> {
  const url = await markedImage(img, (ctx, s) => {
    markers.forEach((m) => {
      const x = m.x * s, y = m.y * s;
      ctx.beginPath();
      ctx.arc(x, y, 7, 0, Math.PI * 2);
      ctx.fillStyle = '#ff2d55';
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = '#fff';
      ctx.stroke();
      tag(ctx, x + 9, y - 6, String(m.n));
    });
  }, 1280);
  const list = markers.map((m) => `${m.n}. at x=${(m.x / w).toFixed(3)}, y=${(m.y / h).toFixed(3)}${m.note ? ` — the user says: "${m.note}"` : ''}${m.color ? ` — colour ${m.color}` : ''}`).join('\n');
  const messages: ChatMessage[] = [
    {
      role: 'system',
      content:
        'You plan an image edit that makes chosen things in a picture glow as lights. The user dropped numbered red dots on the picture. ' +
        'For each dot, decide exactly which object or part of an object is under it, using the user\'s words to narrow it down (if they say "only the rubber of the tyre", it is the tyre rubber, not the wheel or the car). ' +
        'Describe it so an image editor can find it without the dot: name it with its colour, shape and position relative to other things. ' +
        'Then say how it should glow (colour and strength), following the user\'s words, the colour given, and the overall lighting request. ' +
        'Also give a tight box around just that part, as fractions of the picture [x0, y0, x1, y1] with the origin at the top left.',
    },
    {
      role: 'user',
      content: [
        { type: 'image_url', image_url: { url } },
        {
          type: 'text',
          text:
            `The picture was made from: "${prompt}".\n` +
            (lighting ? `Overall lighting request: "${lighting}".\n` : '') +
            `Dots:\n${list}\n\n` +
            'Reply with JSON only: {"lights": [{"n": 1, "object": "the rubber tyre of the front wheel of the red car", "how": "glows bright cyan", "box": [0.1, 0.5, 0.2, 0.7]}]}',
        },
      ],
    },
  ];
  const r = await chat({ ...c, messages, effort: 'low', maxTokens: 1600, json: true, temperature: 0.3 });
  const j = parseJson<{ lights?: { n?: number; object?: string; how?: string; box?: number[] }[] }>(r.content);
  return markers.map((m) => {
    const it = j.lights?.find((x) => Number(x.n) === m.n);
    const box = it?.box?.length === 4 && it.box.every((v) => Number.isFinite(v))
      ? ([Math.max(0, it.box[0]) * w, Math.max(0, it.box[1]) * h, Math.min(1, it.box[2]) * w, Math.min(1, it.box[3]) * h] as [number, number, number, number])
      : undefined;
    return {
      n: m.n,
      object: (it?.object || m.note || `the thing at marker ${m.n}`).slice(0, 160),
      how: (it?.how || (m.color ? `glows ${m.color}` : 'glows softly')).slice(0, 120),
      box: box && box[2] > box[0] && box[3] > box[1] ? box : undefined,
    };
  });
}

/** Without the text model: the user's own notes, with a position so the image editor can find each thing. */
export function planFromNotes(markers: Marker[], w: number, h: number): MarkerPlan[] {
  const where = (x: number, y: number) => {
    const v = y < h / 3 ? 'top' : y > (2 * h) / 3 ? 'bottom' : 'middle';
    const s = x < w / 3 ? 'left' : x > (2 * w) / 3 ? 'right' : 'centre';
    return `${v} ${s}`;
  };
  return markers.map((m) => ({
    n: m.n,
    object: `${m.note || 'the light source'} (in the ${where(m.x, m.y)} of the picture)`,
    how: m.color ? `glows ${m.color}` : 'glows warmly',
  }));
}

// ---------------------------------------------------------------- the director

export interface DirectorScene {
  summary: string;
  zones: { n: number; name: string; x: number; y: number; w: number; h: number; count: number; on: number }[];
  hasMusic: boolean;
}

const FORMAT = `SHOW FORMAT (JSON):
{"name": "short title", "summary": "one sentence", "loop": true or false, "length": seconds (optional), "steps": [ ... ]}
Each step: {"at": seconds from the start, "dur": seconds, "do": action, "target": target, ...options}
Targets: {"all": true} | {"zones": [1, 3]} | {"region": {"x": 0, "y": 0, "w": 0.5, "h": 1}} | {"near": {"x": 0.4, "y": 0.6, "r": 0.1}}; add "except": another target to leave some out. Coordinates are fractions of the picture, origin top left.
Actions:
- "set": jump to level "to" (0 off, 1 full, up to 1.5 extra bright)
- "fade": glide to "to" over dur
- "flicker": blink "times" times over dur, all together in sync; ends at "to" if given, otherwise back on
- "pulse": swell and dim, "period" seconds per beat, "depth" 0..1, while dur runs
- "chase": switch to "to" one after another over dur; "dir" is where the wave travels TO: "right" starts at the left edge and moves right; also "left", "down" (top to bottom), "up", "out" (from the centre outwards), "in"
- "scatter": switch to "to" one by one in random order over dur
- "sparkle": random twinkling while dur runs, "density" 0..1
- "strobe": hard on/off flashes, "rate" per second, while dur runs
- "spark": a quick stuttering flash that settles at "to" (good for something sparking on)
- "color": recolour to "color": "#rrggbb", or "original" for the light's own colour
- "music": follow the music while dur runs, "band": bass, mid, treble or all
Rules: steps apply in order of "at"; later steps win for the same lights. A finished set, fade, flicker, chase, scatter, spark or color keeps its end state; pulse, sparkle, strobe and music only act while they run. Sequences happen one after another by giving later "at" times. Use "loop": true for moods that should repeat, false for a one-off sequence. At most 60 steps.`;

export function directorSystem(s: DirectorScene): string {
  const zones = s.zones.map((z) => `${z.n}. "${z.name}" at x=${z.x.toFixed(2)} y=${z.y.toFixed(2)} w=${z.w.toFixed(2)} h=${z.h.toFixed(2)}, ${z.count} light${z.count === 1 ? '' : 's'}, now ${Math.round(z.on * 100)}% on`).join('\n');
  return (
    'You are the lighting director of an interactive picture. Every light in it can be switched, dimmed, recoloured and animated. ' +
    'You turn what the user asks for into a light show that the app plays at once.\n\n' +
    `THE PICTURE: ${s.summary || 'an illustration with many lights'}\n` +
    `ZONES OF LIGHTS:\n${zones}\n` +
    `Music listener: ${s.hasMusic ? 'on' : 'off (music steps will do nothing until the user turns it on)'}.\n\n` +
    FORMAT +
    '\n\nMatch the user\'s words to zones by what they name ("the windows of the left building") and by position. If nothing matches exactly, use a region. ' +
    'Reply with the JSON object only.'
  );
}

export async function direct(scene: DirectorScene, request: string, history: { request: string; show: Show }[], c: AgentCreds & { onThinking?: (t: string) => void }): Promise<Show> {
  const messages: ChatMessage[] = [{ role: 'system', content: directorSystem(scene) }];
  for (const h of history.slice(-3)) {
    messages.push({ role: 'user', content: h.request });
    messages.push({ role: 'assistant', content: JSON.stringify(h.show) });
  }
  messages.push({ role: 'user', content: request });
  let lastErr: Error | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await chat({ ...c, messages, effort: 'low', maxTokens: 6000, json: true, temperature: 0.6, onDelta: (_t, reasoning) => c.onThinking?.(reasoning) });
    try {
      const show = sanitize(parseJson(r.content));
      if (!show.steps.length) throw new Error('The show had no steps the app can play.');
      return show;
    } catch (err) {
      lastErr = err as Error;
      messages.push({ role: 'assistant', content: r.content.slice(0, 4000) });
      messages.push({ role: 'user', content: `That could not be used (${lastErr.message}). Reply with one JSON object in the show format, nothing else.` });
    }
  }
  throw lastErr ?? new Error('The director did not return a show.');
}
