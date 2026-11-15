import { BaseEdge, type Edge, type EdgeProps, getBezierPath } from "@xyflow/react";
import { memo } from "react";
import { useRunOverlay } from "../../trace/overlay";

/**
 * A transition (design system §4 TransitionPath, ADR-017): a bezier curve, 1.5 px, with an arrowhead. Selected
 * transitions use the accent, the selection colour; nothing else is coloured.
 */
export type TransitionRFEdge = Edge<Record<string, never>, "transition">;

function TransitionEdgeView(props: EdgeProps<TransitionRFEdge>) {
  const [path] = getBezierPath({
    sourceX: props.sourceX,
    sourceY: props.sourceY,
    sourcePosition: props.sourcePosition,
    targetX: props.targetX,
    targetY: props.targetY,
    targetPosition: props.targetPosition,
  });
  // Selection wins over the run overlay, which tints the transitions the last test followed.
  const ran = useRunOverlay().edges.has(props.id);
  const look = props.selected ? "selected" : ran ? "ran" : undefined;
  return (
    <BaseEdge
      id={props.id}
      path={path}
      markerEnd={look ? `url(#wk-arrow-${look})` : "url(#wk-arrow)"}
      className={look ? `wk-edge wk-edge-${look}` : "wk-edge"}
      interactionWidth={16}
    />
  );
}

export const TransitionEdge = memo(TransitionEdgeView);

/** Arrowhead markers, filled with the edge colour tokens through CSS classes. */
export function TransitionMarkers() {
  return (
    <svg aria-hidden="true" className="absolute size-0">
      <defs>
        {[
          ["wk-arrow", "wk-arrow-fill"],
          ["wk-arrow-selected", "wk-arrow-fill-selected"],
          ["wk-arrow-ran", "wk-arrow-fill-ran"],
        ].map(([id, cls]) => (
          <marker
            key={id}
            id={id}
            viewBox="0 0 10 10"
            refX="9"
            refY="5"
            markerWidth="8"
            markerHeight="8"
            orient="auto-start-reverse"
          >
            <path d="M 0 1 L 9 5 L 0 9 z" className={cls} />
          </marker>
        ))}
      </defs>
    </svg>
  );
}
