import { type BotManifest, Problem, type Workflow } from "@wakeel/contracts";
import { FakeClock } from "@wakeel/testing";
import { describe, expect, test } from "vitest";
import { ApiError } from "../../api/client";
import { commands } from "./commands";
import { seededDraft } from "./fixtures.test-utils";
import { AUTOSAVE_DELAY_MS, createSaver, type SaveDoc } from "./saver";
import { createCanvasStore, isDirty } from "./store";

/** The autosaver on a fake clock (CLAUDE.md §7: no real sleeps). */
function setup(save: SaveDoc) {
  const clock = new FakeClock();
  const store = createCanvasStore();
  const { manifest, main } = seededDraft();
  store.getState().load({ botId: "bot_x", manifest: { rev: 0, doc: manifest }, workflows: [{ rev: 0, doc: main }] });
  const saver = createSaver({
    store,
    save,
    timers: { setTimeout: (fn, ms) => clock.setTimeout(fn, ms), clearTimeout: (h) => clock.clearTimeout(h as number) },
  });
  const rename = (name: string) => store.getState().execute(commands.renameNode(main.nodes[1]?.id ?? "", name));
  return { clock, store, saver, main, manifest, rename };
}

const conflict = (rev: number, doc: unknown) =>
  new ApiError(
    Problem.parse({
      type: "x",
      title: "This was changed elsewhere",
      status: 409,
      code: "revision_conflict",
      fix: "Reload",
      requestId: "req_x",
      current: { rev, doc },
    }),
  );

describe("autosave", () => {
  test("waits 800 ms after the last change and sends one save for a burst of edits", async () => {
    const calls: { rev: number; name: string }[] = [];
    const { clock, store, rename, main } = setup(async (_ref, rev, doc) => {
      calls.push({ rev, name: (doc as Workflow).nodes[1]?.name ?? "" });
      return { rev: rev + 1 };
    });
    rename("A");
    await clock.advance(500);
    rename("AB");
    await clock.advance(500);
    rename("ABC");
    await clock.advance(AUTOSAVE_DELAY_MS - 1);
    expect(calls).toEqual([]);
    await clock.advance(1);
    expect(calls).toEqual([{ rev: 0, name: "ABC" }]);
    const doc = store.getState().workflows[main.id];
    expect(doc?.rev).toBe(1);
    expect(isDirty(doc as never)).toBe(false);
  });

  test("a change made while saving is saved afterwards with the new revision", async () => {
    let release: (() => void) | undefined;
    const calls: { rev: number; name: string }[] = [];
    const { clock, store, rename, main } = setup(
      (_ref, rev, doc) =>
        new Promise((resolve) => {
          calls.push({ rev, name: (doc as Workflow).nodes[1]?.name ?? "" });
          release = () => resolve({ rev: rev + 1 });
        }),
    );
    rename("First");
    await clock.advance(AUTOSAVE_DELAY_MS);
    rename("Second");
    release?.();
    await clock.advance(AUTOSAVE_DELAY_MS);
    release?.();
    await clock.advance(0);
    expect(calls).toEqual([
      { rev: 0, name: "First" },
      { rev: 1, name: "Second" },
    ]);
    expect(store.getState().workflows[main.id]?.rev).toBe(2);
    expect(isDirty(store.getState().workflows[main.id] as never)).toBe(false);
  });

  test("a conflict stops saving that document until it is resolved, then saves on the server's revision", async () => {
    const calls: number[] = [];
    let first = true;
    const { clock, store, rename, main } = setup(async (_ref, rev) => {
      calls.push(rev);
      if (first) {
        first = false;
        throw conflict(4, { ...main, name: "Elsewhere" });
      }
      return { rev: rev + 1 };
    });
    rename("Mine");
    await clock.advance(AUTOSAVE_DELAY_MS);
    expect(store.getState().workflows[main.id]?.conflict?.rev).toBe(4);
    rename("Mine again");
    await clock.advance(AUTOSAVE_DELAY_MS * 10);
    expect(calls).toEqual([0]);
    store.getState().resolveConflict(`workflow:${main.id}`, "mine");
    rename("Mine, final");
    await clock.advance(AUTOSAVE_DELAY_MS);
    expect(calls).toEqual([0, 4]);
    expect(store.getState().workflows[main.id]?.rev).toBe(5);
  });

  test("a network failure is kept, shown and retried with backoff", async () => {
    let fail = 2;
    const calls: number[] = [];
    const { clock, store, rename, main } = setup(async (_ref, rev) => {
      calls.push(clock.now());
      if (fail-- > 0) throw new TypeError("Failed to fetch");
      return { rev: rev + 1 };
    });
    const t0 = clock.now();
    rename("Offline edit");
    await clock.advance(AUTOSAVE_DELAY_MS);
    expect(store.getState().workflows[main.id]?.error?.title).toBe("Changes could not be saved");
    await clock.advance(AUTOSAVE_DELAY_MS * 2);
    await clock.advance(AUTOSAVE_DELAY_MS * 4);
    expect(calls.map((t) => t - t0)).toEqual([800, 2400, 5600]);
    expect(store.getState().workflows[main.id]?.error).toBeUndefined();
    expect(isDirty(store.getState().workflows[main.id] as never)).toBe(false);
  });

  test("manifest edits are saved too, and flush saves at once", async () => {
    const refs: string[] = [];
    const { store, saver } = setup(async (ref, rev) => {
      refs.push(ref.kind);
      return { rev: rev + 1 };
    });
    store.getState().updateManifest((m: BotManifest) => ({ ...m, description: "وصف" }));
    await saver.flush();
    expect(refs).toEqual(["manifest"]);
    expect(store.getState().manifest?.rev).toBe(1);
  });

  test("moving nodes is saved like any change (positions live in the document)", async () => {
    const sent: Workflow[] = [];
    const { clock, store, main } = setup(async (_ref, rev, doc) => {
      sent.push(doc as Workflow);
      return { rev: rev + 1 };
    });
    store.getState().execute(commands.moveNodes({ [main.nodes[0]?.id ?? ""]: { x: 40, y: 80 } }));
    await clock.advance(AUTOSAVE_DELAY_MS);
    expect(sent[0]?.layout[main.nodes[0]?.id ?? ""]).toEqual({ x: 40, y: 80 });
  });

  test("stop cancels a pending save", async () => {
    const calls: number[] = [];
    const { clock, saver, rename } = setup(async (_ref, rev) => {
      calls.push(rev);
      return { rev: rev + 1 };
    });
    rename("Never saved");
    saver.stop();
    await clock.advance(AUTOSAVE_DELAY_MS * 2);
    expect(calls).toEqual([]);
  });
});
