import { playback as PLAYBACK, useMotionTokens } from "@wakeel/ui";
import { Pause, Play, SkipForward } from "lucide-react";
import { useEffect, useMemo } from "react";
import { useEmulator } from "../emulator/controller";
import { playbackSchedule } from "./model";

/** The whole turn takes `playback.total` seconds at 1× (§5.3 "Trace playback"). */
export const PLAYBACK_TOTAL_MS = PLAYBACK.total * 1000;

/** The playback schedule of the turn the trace list shows. */
export function useSchedule() {
  const turnId = useEmulator((s) => s.playback?.turnId ?? s.traceTurn);
  const spans = useEmulator((s) => (turnId ? s.traces[turnId] : undefined));
  return useMemo(() => (spans ? playbackSchedule(spans, PLAYBACK_TOTAL_MS) : []), [spans]);
}

/**
 * Drives a running replay: waits until the next step is due, scaled by the speed, then advances.
 * With reduced motion the replay still steps on time, but each step lands at once (§2.6: "trace
 * playback jumps step to step"); the list and the canvas drop their transitions themselves.
 */
export function usePlaybackClock() {
  const playback = useEmulator((s) => s.playback);
  const speed = useEmulator((s) => s.playbackSpeed);
  const advance = useEmulator((s) => s.advance);
  const schedule = useSchedule();
  useEffect(() => {
    if (!playback?.playing) return;
    const here = schedule[playback.index];
    if (!here) return;
    // The last step is held until the turn's whole length has played.
    const until = schedule[playback.index + 1]?.atMs ?? PLAYBACK_TOTAL_MS;
    const wait = Math.max(0, (until - here.atMs) / speed);
    const timer = window.setTimeout(advance, wait);
    return () => window.clearTimeout(timer);
  }, [playback, speed, schedule, advance]);
}

/** ▶ / ❚❚, the speed, and ⏭ (§5.3 PlaybackControls). Only for a finished turn with steps. */
export function PlaybackControls() {
  const playback = useEmulator((s) => s.playback);
  const speed = useEmulator((s) => s.playbackSpeed);
  const running = useEmulator((s) => s.transcript.running);
  const play = useEmulator((s) => s.play);
  const pause = useEmulator((s) => s.pause);
  const stepForward = useEmulator((s) => s.stepForward);
  const setSpeed = useEmulator((s) => s.setSpeed);
  const schedule = useSchedule();
  const tokens = useMotionTokens();
  usePlaybackClock();
  if (running || schedule.length === 0) return null;
  const playing = playback?.playing ?? false;
  const speeds = PLAYBACK.speeds as readonly number[];
  const nextSpeed = speeds[(speeds.indexOf(speed) + 1) % speeds.length] ?? 1;
  const button =
    "wk-press flex h-control-sm items-center justify-center gap-1 rounded-sm px-2 text-small text-secondary hover:bg-subtle hover:text-primary";
  return (
    <span className="flex items-center gap-1" data-reduced={tokens.reduced ? "true" : undefined}>
      <button
        type="button"
        aria-label={playing ? "Pause" : "Play this turn"}
        title={playing ? "Pause" : "Play this turn"}
        onClick={playing ? pause : play}
        className={button}
      >
        {playing ? (
          <Pause className="size-icon-sm" strokeWidth={1.75} aria-hidden="true" />
        ) : (
          <Play className="size-icon-sm" strokeWidth={1.75} aria-hidden="true" />
        )}
      </button>
      <button
        type="button"
        aria-label={`Speed ${speed}×, change to ${nextSpeed}×`}
        title="Playback speed"
        onClick={() => setSpeed(nextSpeed)}
        className={`${button} min-w-control tabular-nums`}
      >
        {speed}×
      </button>
      <button
        type="button"
        aria-label="Next step"
        title="Next step"
        disabled={!!playback && playback.index >= schedule.length - 1}
        onClick={stepForward}
        className={`${button} disabled:opacity-50`}
      >
        <SkipForward className="size-icon-sm" strokeWidth={1.75} aria-hidden="true" />
      </button>
    </span>
  );
}
