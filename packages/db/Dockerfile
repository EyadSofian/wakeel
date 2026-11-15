# syntax=docker/dockerfile:1
#
# One-off release job: creates or updates the database roles, then applies pending migrations.
# Build from the repository root:
#
#   docker build -f packages/db/Dockerfile -t wakeel-migrate .
#
# Needs SUPERUSER_DATABASE_URL, APP_MIGRATOR_PASSWORD, APP_RW_PASSWORD, APP_ADMIN_RO_PASSWORD and
# MIGRATOR_DATABASE_URL. It is the only thing that ever holds the superuser URL; the services never do.

ARG BUILD_IMAGE=node:22.23.2-bookworm-slim@sha256:48e4b67d85f87bd551df43704e24d252f56cc5f8e9718841aace50f19948f0f9

FROM ${BUILD_IMAGE}
ENV CI=1
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile --ignore-scripts --filter "@wakeel/db..." --filter wakeel
USER node
CMD ["sh", "-c", "node --import tsx packages/db/src/cli/bootstrap.ts && node --import tsx packages/db/src/cli/migrate.ts"]
