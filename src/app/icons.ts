const SVG = 'http://www.w3.org/2000/svg';

type Shape = ['path', string] | ['circle', number, number, number] | ['rect', string];

const SHAPES = {
  plus: [['path', 'M12 5v14M5 12h14']],
  prev: [['path', 'm15 6-6 6 6 6']],
  next: [['path', 'm9 6 6 6-6 6']],
  moon: [['path', 'M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5Z']],
  sun: [
    ['circle', 12, 12, 4],
    [
      'path',
      'M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4',
    ],
  ],
  file: [
    ['path', 'M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z'],
    ['path', 'M14 3v5h5M9 13h6M9 17h6'],
  ],
  school: [
    ['path', 'M3 9.5 12 5l9 4.5-9 4.5z'],
    ['path', 'M7 11.5V16c1.5 1.3 3.2 2 5 2s3.5-.7 5-2v-4.5'],
  ],
  x: [['path', 'M6 6l12 12M18 6 6 18']],
  import: [
    ['path', 'M3 12h11M10 8l4 4-4 4'],
    ['path', 'M14 4h5a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-5'],
  ],
  sliders: [
    ['path', 'M4 7h10M18 7h2M4 17h2M10 17h10'],
    ['circle', 16, 7, 2],
    ['circle', 8, 17, 2],
  ],
  pencil: [
    ['path', 'M4 20h4L19 9l-4-4L4 16z'],
    ['path', 'M13.5 6.5l4 4'],
  ],
  trash: [['path', 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13']],
  cmd: [['path', 'M15 6v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3V6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3']],
} satisfies Record<string, Shape[]>;

export type IconName = keyof typeof SHAPES;

export function icon(name: IconName, className = 'ic'): SVGSVGElement {
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('class', className);
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  for (const shape of SHAPES[name] as Shape[]) {
    const el = document.createElementNS(SVG, shape[0]);
    if (shape[0] === 'path') el.setAttribute('d', shape[1]);
    if (shape[0] === 'circle') {
      el.setAttribute('cx', String(shape[1]));
      el.setAttribute('cy', String(shape[2]));
      el.setAttribute('r', String(shape[3]));
    }
    svg.appendChild(el);
  }
  return svg;
}
