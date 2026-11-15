/// <reference lib="webworker" />
import { type BotDefinition, validateDefinition } from "@wakeel/contracts";

/**
 * Validation off the main thread (architecture §3.1: the Studio runs validateDefinition on every
 * change). The same function the api runs at publish time.
 */
self.onmessage = (event: MessageEvent<{ id: number; definition: BotDefinition }>) => {
  const { id, definition } = event.data;
  self.postMessage({ id, issues: validateDefinition(definition) });
};
