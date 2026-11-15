# ADR-044 — Railway production placement and the isolated execution host

Status: accepted (Eyad approved the proposal in writing on 2026-11-15; execution host not yet available) · Date: 2026-11-15 · Security-critical: human review required

## Context

Eyad requested production on Railway, after choosing a gVisor-capable production host. ADR-003
requires `runsc`, a read-only root, dropped capabilities and network isolation. The existing
`deploy-railway.md` explicitly describes internal testing: its sandbox uses development mode,
has no verified gVisor runtime, and Railway has no per-service egress policy in that deployment.

The live Railway project currently has Studio, API, worker, migrate, Postgres, Redis, sandbox and
egress. It has no parser or object-store service. A successful deployment status is not evidence
that the remaining production requirements have been met.

Railway's [private-bridge guide](https://docs.railway.com/guides/bridge-railway-to-rds-with-tailscale)
states that its containers do not allow privilege escalation and documents a private TCP bridge
to an external host. The [gVisor installation guide](https://gvisor.dev/docs/user_guide/install/)
requires installing and selecting the runtime on the Docker host. No supported Railway control
for selecting `runsc` was found. Installing a binary inside a workload would not prove that its
parent container runs under that runtime.

## Options

1. Keep the application control plane and data services on Railway, with an isolated Linux host
   for sandbox, parser and egress, reached over a private authenticated TCP bridge.
2. Move the entire stack to a host whose container runtime and firewall we control. This satisfies
   the existing assumption but does not keep the main application on Railway.
3. Keep everything on Railway and remove the gVisor/network requirements. This is an explicit
   reduction of the accepted isolation design and is not recommended. Development mode or a false
   `SANDBOX_RUNTIME_VERIFIED=1` is not a production solution.

## Recommendation

Option 1:

- Railway hosts Studio, API, worker, the migration job, Postgres/pgvector, Redis and S3-compatible
  storage. Only Studio is public, with the API behind its same-origin proxy. Database, Redis and
  migration credentials retain their existing role separation.
- A dedicated Linux host runs sandbox under gVisor, the parser without outbound network access,
  and egress as the only internet route from those isolated workloads. Sandbox receives no
  database, Redis, object-store, model or egress bearer credentials.
- Use a private TCP bridge following Railway's documented Tailscale pattern. Fixed relay targets
  expose only the required internal service ports to the authorized worker/API services. Do not
  expose `/exec` or the parser as unauthenticated public endpoints. Test the bidirectional NDJSON
  stream, cancellation and connection failures through the bridge before deployment.
- Set `NODE_ENV=production`. Set the runtime verification flag only after the deployment check
  confirms `HostConfig.Runtime=runsc`, read-only root, no capabilities and the required network
  policy. Keep evidence of these checks and the escape/SSRF suites with the deployment record.
- Configure health checks, restart behavior, migration ordering, backups, object versioning,
  retention and a timed restore drill. Validate a fresh environment from the documented steps.
  The existing task 15.1/15.2 human and external review gates still apply.

## Consequences

This keeps the main product on Railway without pretending that its workload settings can change
the host container runtime. It adds one Linux host and a private bridge to operate. The bridge
images and runtime dependencies require licence checks and pinned versions before use.

No production placement is changed by this proposal. Implementation needs approval and access to
the designated Linux host. Security-critical deployment work ends at an open review PR; it does
not merge or waive launch gates itself.

## Decision requested

Approve option 1 and identify the Linux host (an existing SSH alias/address and user, or an approved
provisioning target). If all workloads must run inside Railway, explicitly amend the isolation
requirements through a reviewed ADR rather than silently accepting development settings.


## Approval and deployment constraint

Eyad approved this proposal in writing on 2026-11-15 and confirmed that Railway is currently his only host.
The approved isolation requirements remain in force. No external execution host has been supplied or
provisioned. Railway control-plane preparation and tested application uploads are authorized; the
production execution and fresh-environment acceptance checks remain blocked until a compatible host
or a separately approved isolation design is available. No runtime verification flag may be fabricated.
