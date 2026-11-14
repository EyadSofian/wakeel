/**
 * The exec stream frames now live in `packages/sandbox-client` (ADR-019 §10), shared by this service
 * and its callers. Re-exported here so the service's files keep one import path.
 */
export * from "@wakeel/sandbox-client/protocol";
