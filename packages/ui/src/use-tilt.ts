import { type PointerEvent, useCallback } from "react";
import { useMotionTokens } from "./use-motion-tokens";

/**
 * Leans a `.wk-tilt` element toward the pointer (ADR-033): at most `tilt.max` degrees, only for fine
 * pointers, nothing when motion is reduced. Writes two CSS variables; the transition lives in CSS.
 */
export function useTilt<T extends HTMLElement>() {
  const { tiltMax } = useMotionTokens();
  const onPointerMove = useCallback(
    (e: PointerEvent<T>) => {
      if (tiltMax === 0 || e.pointerType !== "mouse") return;
      const box = e.currentTarget.getBoundingClientRect();
      const x = (e.clientX - box.left) / box.width - 0.5;
      const y = (e.clientY - box.top) / box.height - 0.5;
      e.currentTarget.style.setProperty("--tilt-x", `${(x * 2 * tiltMax).toFixed(2)}deg`);
      e.currentTarget.style.setProperty("--tilt-y", `${(-y * 2 * tiltMax).toFixed(2)}deg`);
    },
    [tiltMax],
  );
  const onPointerLeave = useCallback((e: PointerEvent<T>) => {
    e.currentTarget.style.removeProperty("--tilt-x");
    e.currentTarget.style.removeProperty("--tilt-y");
  }, []);
  return { onPointerMove, onPointerLeave };
}
