/**
 * Checks made before the sandbox takes any work. Architecture §5.3, layer 3: in production the
 * container must run under gVisor (`runsc`), and only the deploy pipeline can tell, so it sets
 * `SANDBOX_RUNTIME_VERIFIED=1` after checking. Without it the service does not start.
 */
export interface BootConfig {
  nodeEnv: "development" | "test" | "production";
  sandboxRuntimeVerified: boolean;
}

/** Why the service must not start, or undefined when it may. */
export function runtimeProblem(config: BootConfig): string | undefined {
  if (config.nodeEnv !== "production" || config.sandboxRuntimeVerified) return undefined;
  return (
    "The sandbox will not start in production on an unverified container runtime. Run it under " +
    "gVisor (runsc), have the deploy pipeline check the runtime, then set SANDBOX_RUNTIME_VERIFIED=1."
  );
}
