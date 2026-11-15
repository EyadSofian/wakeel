# syntax=docker/dockerfile:1
#
# The api service. Build from the repository root:
#
#   docker build -f apps/api/Dockerfile -t wakeel-api .
#
# Same shape as apps/sandbox/Dockerfile: pinned bases, a distroless non-root runtime, and tsx loading
# the TypeScript (the services ship as source; there is no build step yet). Deployment notes:
# docs/runbooks/deploy-railway.md.

# Base images are pinned by digest; update them together with apps/sandbox/Dockerfile.
ARG BUILD_IMAGE=node:22.23.2-bookworm-slim@sha256:48e4b67d85f87bd551df43704e24d252f56cc5f8e9718841aace50f19948f0f9
ARG RUNTIME_IMAGE=gcr.io/distroless/nodejs22-debian12:nonroot@sha256:13593b7570658e8477de39e2f4a1dd25db2f836d68a0ba771251572d23bb4f8e

FROM ${BUILD_IMAGE} AS build
ENV CI=1
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate
WORKDIR /repo
# .dockerignore keeps out node_modules, git, secrets (.env), tests and everything else not needed here.
COPY . .
# The service, the workspace packages it imports, and the root (for tsx). Install scripts never run.
RUN pnpm install --frozen-lockfile --ignore-scripts --filter "@wakeel/api..." --filter wakeel

FROM ${RUNTIME_IMAGE}
USER nonroot
COPY --from=build --chown=root:root /repo /app
WORKDIR /app/apps/api
# Listen on every interface, IPv6 included, so the Studio proxy can reach it on a private network.
ENV NODE_ENV=production \
    HOST=:: \
    PORT=3000 \
    TSX_DISABLE_CACHE=1
EXPOSE 3000
CMD ["--import", "tsx", "src/main.ts"]
