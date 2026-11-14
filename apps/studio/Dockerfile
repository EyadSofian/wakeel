# syntax=docker/dockerfile:1
#
# The Studio: the Vite build served by Caddy, which also forwards /v1 to the api (apps/studio/Caddyfile).
# Build from the repository root:
#
#   docker build -f apps/studio/Dockerfile -t wakeel-studio .
#   docker run -e API_UPSTREAM=api:3000 -p 8080:8080 wakeel-studio

ARG BUILD_IMAGE=node:22.23.2-bookworm-slim@sha256:48e4b67d85f87bd551df43704e24d252f56cc5f8e9718841aace50f19948f0f9
ARG RUNTIME_IMAGE=caddy:2.10.2-alpine

FROM ${BUILD_IMAGE} AS build
ENV CI=1
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate
WORKDIR /repo
COPY . .
# Install scripts stay off; Vite's native parts come from optional prebuilt packages.
RUN pnpm install --frozen-lockfile --ignore-scripts --filter "@wakeel/studio..." --filter wakeel
RUN pnpm --filter @wakeel/studio build

FROM ${RUNTIME_IMAGE}
COPY apps/studio/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /repo/apps/studio/dist /srv
# Caddy keeps its state under XDG dirs; point them somewhere the unprivileged user can write.
ENV PORT=8080 XDG_DATA_HOME=/tmp/caddy-data XDG_CONFIG_HOME=/tmp/caddy-config
EXPOSE 8080
USER nobody
CMD ["caddy", "run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]
