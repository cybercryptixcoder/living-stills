// Prompt templates for the image model.
//
// The user's description is sent as written: no house style, no time of day, no medium is added.
// The only thing the app adds is what the method needs: which lights are on, and, for edits,
// "keep everything else exactly the same" (the light is the difference between two images, so
// anything else that moves is noise).

/** Ideas shown in the composer. Deliberately different media and moods; the user can write anything. */
export const IDEAS: { title: string; prompt: string; lighting: string; element?: string }[] = [
  {
    title: 'Pen sketch',
    prompt: 'A precise architectural pen-and-ink sketch of a corner café on a European street, ruled straight lines, two-point perspective, fine hatching, black ink on white paper',
    lighting: 'the café sign glows warm yellow, the two big windows glow amber, the street lamp casts a soft pool of light',
  },
  {
    title: 'Golden-hour photo',
    prompt: 'A photograph of a cosy independent bookshop interior in late afternoon, tall wooden shelves, a reading nook with armchairs, plants, sunlight through the front window',
    lighting: 'string lights along the shelves, a green banker’s lamp on the counter, a paper floor lamp by the armchair',
  },
  {
    title: 'Pixel arcade',
    prompt: 'Isometric pixel art of a tiny arcade and noodle stand on a street corner, bright colours, crisp pixels',
    lighting: 'neon signs in pink and cyan, the arcade cabinet screens, paper lanterns over the noodle stand',
  },
  {
    title: 'Train on a viaduct',
    prompt: 'A small local train crosses a long stone viaduct over a river, seen from the side, a hillside town behind',
    lighting: 'house windows and street lamps along the river, reflected in the water',
    element: 'the train',
  },
];

/** The first picture of a one-go scene: the description, with its lights switched on. */
export function scenePrompt(description: string, lighting?: string, element?: string): string {
  const parts = [description.trim().replace(/[.\s]+$/, '') + '.'];
  if (lighting?.trim()) parts.push(`Lighting: ${lighting.trim().replace(/[.\s]+$/, '')}. These lights are switched on.`);
  else parts.push('Its light sources are switched on and glowing.');
  if (element) parts.push(`${capitalise(element)} is fully visible in the middle of the frame, seen from the side, with nothing in front of it.`);
  return parts.join(' ');
}

/** The first picture of a two-stage scene: exactly the description (its lights come later). */
export function basePrompt(description: string): string {
  return description.trim();
}

/** Lights-off edit. Says nothing about night or style, so a sunny photo stays sunny and a sketch stays a sketch. */
export function lightsOffPrompt(lighting?: string): string {
  const which = lighting?.trim() ? ` (${lighting.trim().replace(/[.\s]+$/, '')})` : '';
  return (
    `Edit this image: switch off the light sources that are on${which}. ` +
    'Each lamp, sign, screen, window or other light source stays exactly where it is, with the same shape and size, but unlit. ' +
    'Only their light is gone: their glow, the light they cast on surfaces and their reflections disappear. ' +
    'Keep everything else exactly the same: same composition and framing, same objects, same medium and style. Do not move, remove or redraw anything.'
  );
}

/** Two-stage scenes whose first picture is a normal (ambient) image: make the dark version the lights will shine in. */
export const DARK_VERSION_PROMPT =
  'Edit this image: show exactly the same scene in darkness, as if the ambient light was turned far down, with every light source switched off. ' +
  'Keep everything else exactly the same: same composition and framing, same objects, same medium and style. Do not move, remove or redraw anything.';

export function removeElementPrompt(element: string): string {
  return (
    `Edit this image: remove ${element} completely. Where it was, continue the background naturally, matching what is around it. ` +
    'Keep everything else exactly the same: same lights, same reflections, same composition, medium and style. Do not move or redraw anything else.'
  );
}

/** Per-light edit with the lit version as a reference: the model sees what this light looks like when on. */
export const SINGLE_LIGHT_WITH_REFERENCE_PROMPT =
  'Edit the first image: switch on only the light source at the exact centre of the picture, so that it glows the way it does in the second image. ' +
  'It may be a lamp, a lantern, a lit window, a sign, a screen or any glowing object: switch on that object itself, do not add a new light. ' +
  'Every other light stays off, as in the first image. Keep everything else exactly the same as the first image: same framing, same objects, same medium and style.';

/** Light-up edit for placed markers, written from the planner's descriptions (or the user's notes). */
export function lightUpPrompt(items: { n: number; object: string; how: string }[], lighting?: string): string {
  const list = items.map((it) => `${it.n}) ${it.object}: ${it.how}`).join('; ');
  return (
    `Edit this image: make these things glow as light sources — ${list}. ` +
    (lighting?.trim() ? `Overall lighting: ${lighting.trim().replace(/[.\s]+$/, '')}. ` : '') +
    'Each glows only where described and casts soft light onto the surfaces right around it. Nothing else lights up, and no new lights are added. ' +
    'Keep everything else exactly the same: same composition and framing, same objects, same medium and style. Do not move or redraw anything.'
  );
}

function capitalise(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Recreate a photo or artwork as a new image (identical unless the user asks for changes). */
export function recreatePrompt(changes?: string): string {
  const c = changes?.trim().replace(/[.\s]+$/, '');
  return c
    ? `Recreate this image as a new, clean, high-quality image with the same composition, framing, objects, colours, style and medium, with these changes: ${c}. Everything else stays as it is.`
    : 'Recreate this image as a new, clean, high-quality image that looks identical: the same composition and framing, the same objects in the same places, the same colours, lighting, style and medium. Do not add, remove or move anything.';
}

/** Light-up edit from a description alone (no markers): for photos and pictures you already have. */
export function lightFromTextPrompt(lighting: string): string {
  return (
    `Edit this image: switch on these lights so they glow and cast soft light onto the surfaces around them: ${lighting.trim().replace(/[.\s]+$/, '')}. ` +
    'Nothing else lights up and no new objects are added. Keep everything else exactly the same: same composition and framing, same objects, same medium and style. Do not move or redraw anything.'
  );
}
