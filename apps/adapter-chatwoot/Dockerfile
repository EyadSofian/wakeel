# syntax=docker/dockerfile:1
#
# The Chatwoot reference adapter (Phase 14). Build from the repository root:
#
#   docker build -f apps/adapter-chatwoot/Dockerfile -t wakeel-adapter-chatwoot .
#
# Same shape as apps/egress/Dockerfile. It needs a public address: Chatwoot and the platform both
# call it. Configuration: apps/adapter-chatwoot/README.md.

# Base images are pinned by digest; update them together with apps/egress/Dockerfile.
ARG BUILD_IMAGE=node:22.23.2-bookworm-slim@sha256:48e4b67d85f87bd551df43704e24d252f56cc5f8e9718841aace50f19948f0f9
ARG RUNTIME_IMAGE=gcr.io/distroless/nodejs22-debian12:nonroot@sha256:13593b7570658e8477de39e2f4a1dd25db2f836d68a0ba771251572d23bb4f8e

FROM ${BUILD_IMAGE} AS build
ENV CI=1
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate
WORKDIR /repo
COPY . .
# The service, the workspace packages it imports, and the root (for tsx). Install scripts never run.
RUN pnpm install --frozen-lockfile --ignore-scripts --filter "@wakeel/adapter-chatwoot..." --filter wakeel

FROM ${RUNTIME_IMAGE}
USER nonroot
COPY --from=build --chown=root:root /repo /app
WORKDIR /app/apps/adapter-chatwoot
ENV NODE_ENV=production \
    ADAPTER_HOST=:: \
    PORT=4600 \
    TSX_DISABLE_CACHE=1
EXPOSE 4600
CMD ["--import", "tsx", "src/main.ts"]
