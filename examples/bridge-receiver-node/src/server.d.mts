import type { Server } from "node:http";

export interface ReceiverOptions {
  secrets: string[];
  onEvent?: (event: Record<string, unknown>) => void | Promise<void>;
  seen?: { has(id: string): boolean; add(id: string): unknown };
}

export function createReceiver(options: ReceiverOptions): Server;
