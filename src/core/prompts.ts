// Prompt templates. Edits always restate "keep everything else exactly the same":
// the difference between two images is the light, so anything else that moves is noise.

export interface StyleOption {
  id: string;
  name: string;
  text: string;
}

export const STYLES: StyleOption[] = [
  { id: 'watercolour', name: 'Watercolour anime', text: 'soft painterly anime background art, gentle watercolour texture, delicate light, quiet and dreamlike' },
  { id: 'gouache', name: 'Gouache', text: 'gouache painting with matte layered brushwork, muted night palette, storybook calm' },
  { id: 'ink', name: 'Ink and wash', text: 'ink and wash illustration, fine linework, washed colour, misty and still' },
  { id: 'film', name: 'Night photograph', text: 'cinematic night photograph on 35mm film, soft halation, fine grain, still air' },
];

export const styleById = (id: string) => STYLES.find((s) => s.id === id) ?? STYLES[0];

export const IDEAS: { title: string; name: string; prompt: string; element?: string }[] = [
  {
    title: 'Train over a viaduct',
    name: 'Night Viaduct',
    prompt: 'A small local train crosses a long, low stone arch viaduct over a still river, seen exactly from the side from far away. A sleepy hillside town behind with house windows and street lamps along the riverbank, their light reflected in the dark water',
    element: 'the train',
  },
  {
    title: 'City of windows',
    name: 'Window City',
    prompt: 'Dense old apartment blocks seen from across a canal, hundreds of small windows, balconies with plants, laundry lines and air-conditioner units, a narrow street at the bottom, light rain',
  },
  {
    title: 'Rainy alley',
    name: 'Rain Alley',
    prompt: 'A narrow back alley after rain, wet stone paving, a few hanging lanterns, a glowing vending machine, a paper-shade window, an old street lamp, puddles reflecting the light',
  },
  {
    title: 'Harbour',
    name: 'Harbour Lights',
    prompt: 'A small fishing harbour, wooden piers, moored boats with cabin lights, a lighthouse at the end of the breakwater, warehouses with lit windows, calm water reflections',
  },
];

export function scenePrompt(description: string, style: StyleOption, element?: string): string {
  const parts = [
    description.trim().replace(/\.$/, '') + '.',
    'It is late at night and the scene’s own lights are on: lit windows, lamps and other warm light sources glow softly and spill light onto the surfaces around them.',
  ];
  if (element) parts.push(`${capitalise(element)} is fully visible in the middle of the frame, seen from the side, with nothing in front of it.`);
  parts.push(`Style: ${style.text}.`);
  parts.push('No people, no text, no watermark.');
  return parts.join(' ');
}

export const LIGHTS_OFF_PROMPT =
  'Edit this image: show the same scene a moment after every artificial light was switched off. ' +
  'Every lamp, lantern, light fixture, sign, screen, window and vending machine stays exactly where it is, with the same shape and size, but unlit and dark. ' +
  'Only the light is gone: their glow, the light pools on walls and ground, and their reflections disappear. The scene stays a night scene lit only by faint moonlight. ' +
  'Keep everything else exactly the same: same composition and framing, same objects, same painting style. Do not move, remove or redraw anything.';

export function removeElementPrompt(element: string): string {
  return (
    `Edit this image: remove ${element} completely. Where it was, continue the background naturally, matching what is around it. ` +
    'Keep everything else exactly the same: same lights, same reflections, same composition and painting style. Do not move or redraw anything else.'
  );
}

export const SINGLE_LIGHT_PROMPT =
  'Edit this image: switch on the single light source at the exact centre of the picture (a lamp, lantern, sign or window). ' +
  'It glows with warm light and softly lights the surfaces right around it. Every other light stays off. ' +
  'Keep everything else exactly the same: same framing, same objects, same painting style.';

/** Per-light edit with the lit version as a reference: the model sees what this light looks like when on. */
export const SINGLE_LIGHT_WITH_REFERENCE_PROMPT =
  'Edit the first image: switch on only the light source at the exact centre of the picture, so that it glows the way it does in the second image. ' +
  'It may be a lamp, a lantern, a lit window, a sign or a vending machine: switch on that object itself, do not add a new lamp. ' +
  'Every other light stays off, as in the first image. Keep everything else exactly the same as the first image: same framing, same objects, same painting style.';

export function groupLightsPrompt(element?: string): string {
  return (
    'Edit the first image: switch on the lamps and windows in the middle part of the picture so they glow the way they do in the second image, spilling the same soft light around them. ' +
    `Lights near the edges of the picture stay off${element ? `, and ${element} stays exactly as it is in the first image, unlit` : ''}. ` +
    'Keep everything else exactly the same as the first image: same framing, same objects, same painting style.'
  );
}

export function elementLightsPrompt(element: string): string {
  return (
    `Edit the first image: switch on the interior lights of ${element} in the middle of the picture, so its windows glow the way they do in the second image and cast soft light onto what is around it. ` +
    'Every other light stays off, as in the first image. Keep everything else exactly the same as the first image: same framing, same objects, same painting style.'
  );
}

function capitalise(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
