import { formatHex, rgb } from "culori";

/**
 * Colour-vision-deficiency simulation for palette previews and tests.
 * Dichromacy uses the Machado, Oliveira & Fernandes (2009) matrices at
 * severity 1.0, applied in linear RGB; "grayscale" maps to relative
 * luminance (Rec. 709 weights), i.e. what a monochrome display shows.
 */
export const CVD_TYPES = ["deuteranopia", "protanopia", "tritanopia", "grayscale"] as const;
export type CvdType = (typeof CVD_TYPES)[number];

type Row = readonly [number, number, number];
type Matrix = readonly [Row, Row, Row];

const MACHADO_2009: Readonly<Record<Exclude<CvdType, "grayscale">, Matrix>> = {
  protanopia: [
    [0.152286, 1.052583, -0.204868],
    [0.114503, 0.786281, 0.099216],
    [-0.003882, -0.048116, 1.051998],
  ],
  deuteranopia: [
    [0.367322, 0.860646, -0.227968],
    [0.280085, 0.672501, 0.047413],
    [-0.01182, 0.04294, 0.968881],
  ],
  tritanopia: [
    [1.255528, -0.076749, -0.178779],
    [-0.078411, 0.930809, 0.147602],
    [0.004733, 0.691367, 0.3039],
  ],
};

function toLinear(channel: number): number {
  return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
}

function toGamma(channel: number): number {
  const v = Math.min(1, Math.max(0, channel));
  return v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055;
}

function apply(matrix: Matrix, [r, g, b]: Row): Row {
  const [m0, m1, m2] = matrix;
  return [
    m0[0] * r + m0[1] * g + m0[2] * b,
    m1[0] * r + m1[1] * g + m1[2] * b,
    m2[0] * r + m2[1] * g + m2[2] * b,
  ];
}

/** Returns the #rrggbb a viewer with the given deficiency would perceive. */
export function simulate(hex: string, type: CvdType): string {
  const color = rgb(hex);
  if (!color) throw new Error(`Unparseable colour: ${hex}`);
  const linear: Row = [toLinear(color.r), toLinear(color.g), toLinear(color.b)];
  let out: Row;
  if (type === "grayscale") {
    const y = 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
    out = [y, y, y];
  } else {
    out = apply(MACHADO_2009[type], linear);
  }
  return formatHex({ mode: "rgb", r: toGamma(out[0]), g: toGamma(out[1]), b: toGamma(out[2]) });
}
