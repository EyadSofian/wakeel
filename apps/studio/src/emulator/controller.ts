import type { BridgeEvent, EmulatorStateResponse, Json } from "@wakeel/contracts";
import { createContext, useContext } from "react";
import { useStore } from "zustand";
import { createStore, type StoreApi } from "zustand/vanilla";
import { ApiError } from "../api/client";
import {
  applyEvent,
  changedVariables,
  emptyTranscript,
  requestFailed,
  startTurn,
  type Transcript,
  userMessage,
  userPostback,
} from "./model";

/** The network side of the emulator; `api.ts` implements it over fetch, tests over a script. */
export interface EmulatorTransport {
  /** POST with `Accept: text/event-stream`; calls `onEvent` per Bridge event; throws `ApiError`. */
  stream(path: string, body: unknown, onEvent: (event: BridgeEvent) => void): Promise<void>;
  put(path: string, body: unknown): Promise<unknown>;
  get(path: string): Promise<EmulatorStateResponse>;
}

/** The emulator's end user: the data the "as Test user" form edits (§5.3). */
export interface TestUser {
  name?: string | undefined;
  locale?: string | undefined;
  attributes: Record<string, Json>;
}

export interface EmulatorState {
  /** The right panel shows the emulator rather than the inspector. */
  open: boolean;
  /** The external id of the current test conversation (`emu-…`); a reset makes a new one. */
  conversation: string;
  /** Whether the API has seen this conversation yet (the first message names the user). */
  started: boolean;
  user: TestUser;
  transcript: Transcript;
  /** "Run from here" names the node the conversation started at. */
  startedAt: string | undefined;
  variables: EmulatorStateResponse | undefined;
  /** Variable ids whose value changed in the last turn. */
  changed: ReadonlySet<string>;
  setOpen(open: boolean): void;
  send(text: string): Promise<void>;
  postback(value: string, label: string): Promise<void>;
  reset(): void;
  runFrom(workflowId: string, nodeId: string, nodeName: string): Promise<void>;
  saveUser(user: TestUser): Promise<void>;
  refreshVariables(): Promise<void>;
}

export type EmulatorStore = StoreApi<EmulatorState>;

/** The test user's id on the emulator connection. One per builder session is enough. */
export const TEST_USER_ID = "test-user";
const DEFAULT_USER: TestUser = { name: "Test user", attributes: {} };

const newId = () => `emu-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

/**
 * The emulator (task 4.6, ADR-025): a Bridge client on the builder's draft connection, streaming
 * each turn over SSE through the Studio emulator routes.
 */
export function createEmulatorStore(options: {
  base: string;
  transport: EmulatorTransport;
  newConversationId?: () => string;
  /** Awaited before each turn: the canvas waits for autosave, so the turn runs the latest draft. */
  beforeTurn?: () => Promise<void>;
}): EmulatorStore {
  const { base, transport } = options;
  const nextId = options.newConversationId ?? newId;

  return createStore<EmulatorState>((set, get) => {
    const userData = (u: TestUser) => ({
      ...(u.name ? { name: u.name } : {}),
      ...(u.locale ? { locale: u.locale } : {}),
      attributes: u.attributes,
    });
    /** Who the request is from: the first request of a conversation also sends the user's data. */
    const sender = () =>
      get().started ? { userId: TEST_USER_ID } : { userId: TEST_USER_ID, user: userData(get().user) };

    async function turn(path: string, body: unknown): Promise<void> {
      const conversation = get().conversation;
      set((s) => ({ transcript: startTurn(s.transcript), started: true }));
      await options.beforeTurn?.();
      // Events of a conversation that was reset meanwhile are dropped.
      const apply = (e: BridgeEvent) => {
        if (get().conversation === conversation) set((s) => ({ transcript: applyEvent(s.transcript, e) }));
      };
      try {
        await transport.stream(path, body, apply);
      } catch (error) {
        if (get().conversation !== conversation) return;
        const problem =
          error instanceof ApiError
            ? { title: error.problem.title, fix: error.problem.fix }
            : { title: "The emulator lost its connection", fix: "Check your connection and send the message again." };
        set((s) => ({ transcript: requestFailed(s.transcript, problem) }));
        return;
      }
      if (get().conversation !== conversation) return;
      if (get().transcript.running) {
        // The hold ended (55 s) before the turn did.
        set((s) => ({
          transcript: requestFailed(s.transcript, {
            title: "The turn is still running",
            fix: "It took longer than the emulator waits. Send another message to see where it is.",
          }),
        }));
      }
      await get().refreshVariables();
    }

    /** A user message as the request body takes it (the API applies the schema's defaults). */
    async function message(payload: Record<string, Json>): Promise<void> {
      const path = `${base}/conversations/${get().conversation}/messages`;
      await turn(path, { ...sender(), message: payload });
    }

    return {
      open: false,
      conversation: nextId(),
      started: false,
      user: DEFAULT_USER,
      transcript: emptyTranscript(),
      startedAt: undefined,
      variables: undefined,
      changed: new Set(),
      setOpen: (open) => set({ open }),
      async send(text) {
        set((s) => ({ transcript: userMessage(s.transcript, text) }));
        await message({ type: "text", text });
      },
      async postback(value, label) {
        set((s) => ({ transcript: userPostback(s.transcript, value, label) }));
        await message({ type: "postback", value, label });
      },
      reset() {
        set({
          conversation: nextId(),
          started: false,
          transcript: emptyTranscript(),
          startedAt: undefined,
          variables: undefined,
          changed: new Set(),
        });
      },
      async runFrom(workflowId, nodeId, nodeName) {
        get().reset();
        set({ open: true, startedAt: nodeName });
        const path = `${base}/conversations/${get().conversation}/run-from`;
        await turn(path, { ...sender(), workflowId, nodeId });
      },
      async saveUser(user) {
        set({ user });
        if (!get().started) return;
        await transport.put(`${base}/users/${TEST_USER_ID}`, userData(user));
        await get().refreshVariables();
      },
      async refreshVariables() {
        const conversation = get().conversation;
        try {
          const next = await transport.get(`${base}/conversations/${conversation}/state`);
          if (get().conversation !== conversation) return;
          set((s) => ({ variables: next, changed: changedVariables(s.variables, next) }));
        } catch {
          // The Variables tab shows its own error state; the transcript is unaffected.
          if (get().conversation === conversation) set({ variables: undefined });
        }
      },
    };
  });
}

export const EmulatorStoreContext = createContext<EmulatorStore | null>(null);

/** The emulator of the open bot, or null outside the canvas (for optional callers). */
export const useEmulatorStoreOptional = () => useContext(EmulatorStoreContext);

export function useEmulator<T>(selector: (s: EmulatorState) => T): T {
  const store = useContext(EmulatorStoreContext);
  if (!store) throw new Error("useEmulator is used outside the bot canvas.");
  return useStore(store, selector);
}
