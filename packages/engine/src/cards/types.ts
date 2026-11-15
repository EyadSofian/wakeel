import type { Card } from "@wakeel/contracts";
import type { CardExecutor } from "../ports";

export type CardOf<T extends Card["type"]> = Extract<Card, { type: T }>;
export type ExecutorOf<T extends Card["type"]> = CardExecutor<CardOf<T>>;
