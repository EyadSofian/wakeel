/**
 * Height of the code drawer as a share of the canvas (design system §5.2: 60%, resizable). Pure,
 * so the limits and the keyboard steps are tested without a screen.
 */
export const DRAWER = {
  /** Where it opens. */
  initial: 0.6,
  /** Enough for the header and a few lines. */
  min: 0.25,
  /** Leaves a strip of canvas so the node being edited stays in view. */
  max: 0.9,
  /** One arrow-key press on the handle; Shift moves by `bigStep`. */
  step: 0.05,
  bigStep: 0.2,
} as const;

export const clampDrawer = (share: number): number => Math.min(DRAWER.max, Math.max(DRAWER.min, share));

/** The share after dragging the handle to `pointerY` inside a container from `top` to `bottom`. */
export function shareAtPointer(pointerY: number, top: number, bottom: number): number {
  const height = bottom - top;
  if (height <= 0) return DRAWER.initial;
  return clampDrawer((bottom - pointerY) / height);
}

/** The share after a key on the resize handle, or undefined when the key does not resize. */
export function shareAfterKey(share: number, key: string, shift: boolean): number | undefined {
  const step = shift ? DRAWER.bigStep : DRAWER.step;
  switch (key) {
    case "ArrowUp":
      return clampDrawer(share + step);
    case "ArrowDown":
      return clampDrawer(share - step);
    case "Home":
      return DRAWER.max;
    case "End":
      return DRAWER.min;
    default:
      return undefined;
  }
}
