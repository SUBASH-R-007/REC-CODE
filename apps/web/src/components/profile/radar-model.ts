/**
 * Skill-radar geometry: one axis per topic, clockwise from 12 o'clock. Pure.
 */

export interface Point {
  x: number;
  y: number;
}

/** A round scale ceiling: a multiple of the ring count, at least one solve per ring. */
export function radarScaleMax(values: readonly number[], rings = 4): number {
  const max = Math.max(0, ...values);
  return Math.max(rings, Math.ceil(max / rings) * rings);
}

export function axisAngle(index: number, count: number): number {
  return -Math.PI / 2 + (2 * Math.PI * index) / count;
}

export function radarPoint(index: number, count: number, fraction: number, radius: number, center: Point): Point {
  const angle = axisAngle(index, count);
  const r = Math.max(0, Math.min(1, fraction)) * radius;
  return { x: round(center.x + r * Math.cos(angle)), y: round(center.y + r * Math.sin(angle)) };
}

/** SVG points attribute for the data polygon. */
export function radarPolygon(values: readonly number[], max: number, radius: number, center: Point): string {
  return values
    .map((v, i) => radarPoint(i, values.length, max > 0 ? v / max : 0, radius, center))
    .map((p) => `${p.x},${p.y}`)
    .join(" ");
}

/** A ring at `fraction` of the radius, as an SVG points attribute. */
export function radarRing(count: number, fraction: number, radius: number, center: Point): string {
  return Array.from({ length: count }, (_, i) => radarPoint(i, count, fraction, radius, center))
    .map((p) => `${p.x},${p.y}`)
    .join(" ");
}

export function labelAnchor(index: number, count: number): "start" | "middle" | "end" {
  const cos = Math.cos(axisAngle(index, count));
  if (cos > 0.25) return "start";
  if (cos < -0.25) return "end";
  return "middle";
}

/** Break a long axis label at the space nearest its middle (at most two lines). */
export function wrapLabel(label: string, maxLine = 12): string[] {
  if (label.length <= maxLine) return [label];
  const spaces = [...label.matchAll(/ /g)].map((m) => m.index);
  if (spaces.length === 0) return [label];
  const middle = label.length / 2;
  const cut = spaces.reduce((best, s) => (Math.abs(s - middle) < Math.abs(best - middle) ? s : best));
  return [label.slice(0, cut), label.slice(cut + 1)];
}

function round(n: number): number {
  return Math.round(n * 10) / 10;
}
