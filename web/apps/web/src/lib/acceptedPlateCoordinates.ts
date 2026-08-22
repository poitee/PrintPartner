export type AffineMatrix = Readonly<{
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
}>;

type PrintableBounds = Readonly<{
  bedWidthUm: number;
  bedDepthUm: number;
  marginUm: number;
  unitWidthUm: number;
  unitDepthUm: number;
}>;

type PointerOriginInput = PrintableBounds & Readonly<{
  clientX: number;
  clientY: number;
  screenTransform: AffineMatrix;
  grabOffsetXUm: number;
  grabOffsetYUm: number;
}>;

export function acceptedPlatePositionInBounds(
  input: PrintableBounds & Readonly<{ xUm: number; yUm: number }>,
): boolean {
  return (
    Number.isSafeInteger(input.xUm) &&
    Number.isSafeInteger(input.yUm) &&
    input.xUm >= input.marginUm &&
    input.yUm >= input.marginUm &&
    input.xUm + input.unitWidthUm <= input.bedWidthUm - input.marginUm &&
    input.yUm + input.unitDepthUm <= input.bedDepthUm - input.marginUm
  );
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

export function pointerToAcceptedPlateOrigin(
  input: PointerOriginInput,
): Readonly<{ xUm: number; yUm: number }> | null {
  const point = screenToAcceptedPlatePoint({
    clientX: input.clientX,
    clientY: input.clientY,
    screenTransform: input.screenTransform,
  });
  if (!point) return null;
  const maximumX = input.bedWidthUm - input.marginUm - input.unitWidthUm;
  const maximumY = input.bedDepthUm - input.marginUm - input.unitDepthUm;
  if (maximumX < input.marginUm || maximumY < input.marginUm) return null;
  return {
    xUm: Math.round(clamp(point.xUm - input.grabOffsetXUm, input.marginUm, maximumX)),
    yUm: Math.round(clamp(point.yUm - input.grabOffsetYUm, input.marginUm, maximumY)),
  };
}

export function screenToAcceptedPlatePoint(input: Readonly<{
  clientX: number;
  clientY: number;
  screenTransform: AffineMatrix;
}>): Readonly<{ xUm: number; yUm: number }> | null {
  const matrix = input.screenTransform;
  const determinant = matrix.a * matrix.d - matrix.b * matrix.c;
  if (!Number.isFinite(determinant) || determinant === 0) return null;
  const translatedX = input.clientX - matrix.e;
  const translatedY = input.clientY - matrix.f;
  return {
    xUm: (matrix.d * translatedX - matrix.c * translatedY) / determinant,
    yUm: (-matrix.b * translatedX + matrix.a * translatedY) / determinant,
  };
}

export function parseMillimetresToMicrometres(value: string): number | null {
  const match = /^(-?)(\d+)(?:\.(\d{1,3}))?$/.exec(value.trim());
  if (!match) return null;
  const sign = match[1] === "-" ? -1n : 1n;
  const whole = match[2];
  if (whole === undefined) return null;
  const fractional = (match[3] ?? "").padEnd(3, "0");
  const micrometres = sign * (BigInt(whole) * 1_000n + BigInt(fractional || "0"));
  const number = Number(micrometres);
  return Number.isSafeInteger(number) ? number : null;
}
