import type { AutonomousNode } from "@wakeel/contracts";
import type { AutonomyProtocol, ProtocolContext } from "./types";

export const protocolV1: AutonomyProtocol = {
  id: "directives_v1",
  stopSequences: [],
  createReader() {
    throw new Error("not implemented");
  },
};

export function contextFromNode(_node: AutonomousNode): ProtocolContext {
  throw new Error("not implemented");
}
