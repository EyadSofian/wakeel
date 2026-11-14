import { generateTypings } from "@wakeel/contracts";
import {
  Banner,
  Button,
  enterTransition,
  exitTransition,
  fromEdge,
  IconTile,
  Kbd,
  Skeleton,
  useMotionTokens,
} from "@wakeel/ui";
import { Code, Play, X } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { type KeyboardEvent, type PointerEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useCanvas, useCanvasStore } from "../canvas/context";
import { useUi, useUiStore } from "../canvas/interaction/ui-store";
import { commands } from "../canvas/store/commands";
import { CodeEditor } from "./CodeEditor";
import { DRAWER, shareAfterKey, shareAtPointer } from "./drawer-size";
import { loadMonaco, type Monaco } from "./monaco-loader";

/**
 * The code editor drawer (design system §5.2, task 2.9): Run code opens its code in a drawer over
 * the bottom of the canvas, 60% of its height and resizable, with the bot's typings. `Esc` closes
 * it and gives focus back to what opened it. `⌘Enter` will run the code with the last emulator
 * scope once the emulator exists (4.6); until then it says so. Slides up on `spring.smooth`.
 */
export function CodeDrawer() {
  const target = useUi((s) => s.code);
  return <AnimatePresence>{target ? <Drawer key={target.cardId} {...target} /> : null}</AnimatePresence>;
}

type LoadState = { status: "loading" } | { status: "ready"; monaco: Monaco } | { status: "failed" };

function Drawer({ nodeId, cardId }: { nodeId: string; cardId: string }) {
  const ui = useUiStore();
  const store = useCanvasStore();
  const tokens = useMotionTokens();
  const manifest = useCanvas((s) => s.manifest?.doc);
  const workflow = useCanvas((s) => (s.activeWorkflowId ? s.workflows[s.activeWorkflowId]?.doc : undefined));
  const share = useUi((s) => s.codeShare);
  const node = workflow?.nodes.find((n) => n.id === nodeId);
  const card = node?.type === "standard" ? node.cards.find((c) => c.id === cardId) : undefined;
  const code = card?.type === "code" ? card : undefined;

  const close = useCallback(() => ui.getState().set({ code: undefined }), [ui]);
  // The card went away (deleted, undone, another workflow opened): nothing left to edit.
  useEffect(() => {
    if (!code) close();
  }, [code, close]);

  // Focus goes back to whatever opened the drawer (the inspector's "Edit code" button).
  const opener = useRef<Element | null>(null);
  useEffect(() => {
    opener.current = document.activeElement;
    return () => {
      const el = opener.current;
      if (el instanceof HTMLElement && el.isConnected) el.focus();
    };
  }, []);

  const [load, setLoad] = useState<LoadState>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `attempt` is the retry trigger.
  useEffect(() => {
    let live = true;
    setLoad({ status: "loading" });
    loadMonaco().then(
      (monaco) => live && setLoad({ status: "ready", monaco }),
      () => live && setLoad({ status: "failed" }),
    );
    return () => {
      live = false;
    };
  }, [attempt]);

  const typings = useMemo(
    () => (manifest && workflow ? generateTypings({ manifest, workflow }) : ""),
    [manifest, workflow],
  );

  const [said, setSaid] = useState("");
  const onRun = useCallback(() => setSaid("Running code arrives with the emulator. Your code is saved."), []);

  const commit = (source: string) => {
    if (!code) return;
    store.getState().execute(commands.updateCard(nodeId, { ...code, source }));
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape" && !e.defaultPrevented) {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  };

  if (!code || !node || !workflow) return null;
  const nodeName = node.name;
  return (
    <motion.section
      aria-label={`Code of Run code in ${nodeName}`}
      onKeyDown={onKeyDown}
      className="nodrag nowheel absolute inset-x-0 bottom-0 z-30 flex h-(--drawer-height) flex-col border-t border-hairline bg-surface shadow-pop"
      style={{ "--drawer-height": `${share * 100}%` } as React.CSSProperties}
      initial={tokens.reduced ? { opacity: 0 } : { y: fromEdge }}
      animate={
        tokens.reduced
          ? { opacity: 1, transition: enterTransition(tokens, "smooth").opacity }
          : { y: 0, transition: tokens.spring.smooth }
      }
      exit={{ opacity: 0, transition: exitTransition(tokens, "smooth") }}
    >
      <ResizeHandle share={share} onChange={(codeShare) => ui.getState().set({ codeShare })} />
      <header className="flex shrink-0 items-center gap-4 border-b border-hairline px-6 pb-4">
        <IconTile category="tool" icon={Code} size="sm" />
        <div className="flex min-w-0 flex-1 items-baseline gap-3">
          <h2 className="shrink-0 text-title text-primary">Run code</h2>
          <p className="min-w-0 truncate text-small text-secondary">
            <bdi>{workflow.name}</bdi> › <bdi>{nodeName}</bdi>
          </p>
        </div>
        <Button
          icon={<Play className="size-icon" strokeWidth={1.75} aria-hidden="true" />}
          disabled
          title="Running code arrives with the emulator"
        >
          Run
        </Button>
        <button
          type="button"
          aria-label="Close the code editor"
          title="Close (Esc)"
          onClick={close}
          className="flex size-control-sm shrink-0 items-center justify-center rounded-sm text-secondary transition-colors hover:bg-subtle hover:text-primary"
        >
          <X className="size-icon" strokeWidth={1.75} aria-hidden="true" />
        </button>
      </header>
      <div className="relative min-h-0 flex-1">
        {load.status === "ready" ? (
          <CodeEditor
            monaco={load.monaco}
            modelId={cardId}
            value={code.source}
            typings={typings}
            label={`Code of Run code in ${nodeName}`}
            onCommit={commit}
            onRun={onRun}
            onEscape={close}
          />
        ) : load.status === "loading" ? (
          <EditorSkeleton />
        ) : (
          <div className="p-6">
            <Banner tone="error" title="The code editor did not load">
              <p>Check your connection, then try again. Your code is safe in the card.</p>
              <Button className="mt-4" onClick={() => setAttempt((n) => n + 1)}>
                Try again
              </Button>
            </Banner>
          </div>
        )}
      </div>
      <footer className="flex shrink-0 items-center gap-6 border-t border-hairline bg-subtle px-6 py-3 text-small text-secondary">
        <span>JavaScript</span>
        <span className="flex items-center gap-2">
          <Kbd>⌘</Kbd>
          <Kbd>Enter</Kbd> Run
        </span>
        <span className="flex items-center gap-2">
          <Kbd>Esc</Kbd> Close
        </span>
        <span role="status" aria-live="polite" className="ms-auto truncate">
          {said}
        </span>
      </footer>
    </motion.section>
  );
}

/** The top edge: drag, or focus it and use the arrow keys, to change the drawer's height. */
function ResizeHandle({ share, onChange }: { share: number; onChange: (share: number) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const container = () => ref.current?.closest("section")?.parentElement?.getBoundingClientRect();
  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
    const box = container();
    if (box) onChange(shareAtPointer(e.clientY, box.top, box.bottom));
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const next = shareAfterKey(share, e.key, e.shiftKey);
    if (next === undefined) return;
    e.preventDefault();
    onChange(next);
  };
  return (
    // biome-ignore lint/a11y/useSemanticElements: a focusable, adjustable separator (ARIA window splitter); <hr> cannot take focus.
    <div
      ref={ref}
      role="separator"
      aria-orientation="horizontal"
      aria-label="Resize the code editor"
      aria-valuemin={Math.round(DRAWER.min * 100)}
      aria-valuemax={Math.round(DRAWER.max * 100)}
      aria-valuenow={Math.round(share * 100)}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onKeyDown={onKeyDown}
      className="group flex h-5 shrink-0 cursor-row-resize items-center justify-center rounded-t-md"
    >
      <span className="h-1 w-9 rounded-full bg-muted transition-colors group-hover:bg-strong" aria-hidden="true" />
    </div>
  );
}

/** Lines of code-shaped placeholders while Monaco loads (it is a separate download). */
function EditorSkeleton() {
  return (
    <div role="status" className="flex flex-col gap-4 p-6" aria-busy="true" aria-label="Loading the code editor">
      <Skeleton className="h-3 w-9/12" />
      <Skeleton className="h-3 w-7/12" />
      <Skeleton className="h-3 w-10/12" />
      <Skeleton className="h-3 w-5/12" />
    </div>
  );
}
