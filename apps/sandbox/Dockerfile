# syntax=docker/dockerfile:1
#
# The code sandbox (architecture §5, ADR-003, build plan 3.4). Build from the repository root:
#
#   docker build -f apps/sandbox/Dockerfile -t wakeel-sandbox .
#
# The image runs as a non-root user with nothing to write. The rest of layer 3 is set where the
# container is started, never left to the defaults (docs/security/sandbox-review.md §5):
#
#   docker run --read-only --cap-drop ALL --security-opt no-new-privileges \
#     --runtime runsc -e SANDBOX_RUNTIME_VERIFIED=1 -p 4300:4300 wakeel-sandbox
#
# Docker's default seccomp profile applies unless it is turned off; never pass seccomp=unconfined.
# In production the service refuses to start without SANDBOX_RUNTIME_VERIFIED=1, which only the deploy
# pipeline sets after checking the runtime is gVisor (runsc).

# Base images are pinned by digest; update both together.
ARG BUILD_IMAGE=node:22.23.2-bookworm-slim@sha256:48e4b67d85f87bd551df43704e24d252f56cc5f8e9718841aace50f19948f0f9
ARG RUNTIME_IMAGE=gcr.io/distroless/nodejs22-debian12:nonroot@sha256:13593b7570658e8477de39e2f4a1dd25db2f836d68a0ba771251572d23bb4f8e

FROM ${BUILD_IMAGE} AS build
ENV CI=1
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate
WORKDIR /repo
# .dockerignore keeps out node_modules, git, secrets (.env), tests and everything else not needed here.
COPY . .
# Production dependencies of the sandbox and the workspace packages it imports, nothing else.
# Install scripts never run: nothing the sandbox uses needs one.
RUN pnpm install --frozen-lockfile --prod --ignore-scripts --filter "@wakeel/sandbox..."

FROM ${RUNTIME_IMAGE}
# Distroless: no shell, no package manager. `nonroot` is uid 65532.
USER nonroot
COPY --from=build --chown=root:root /repo /app
WORKDIR /app/apps/sandbox
ENV NODE_ENV=production \
    SANDBOX_HOST=0.0.0.0 \
    SANDBOX_PORT=4300 \
    # The root filesystem is read-only: tsx keeps its compile cache in memory instead of /tmp.
    TSX_DISABLE_CACHE=1
EXPOSE 4300
# The image's entrypoint is node. tsx loads the TypeScript; the runner threads inherit the flag.
CMD ["--import", "tsx", "src/main.ts"]
