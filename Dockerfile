# syntax=docker/dockerfile:1.7
#
# Production image: the React bundle built by Node, served by the Axum binary.
#
#   docker build -t portal .
#   docker run --rm -p 3000:3000 \
#     -e DATABASE_URL='postgres://portal:secret@host.docker.internal:5432/portal' \
#     -e ADMIN_USERNAME=admin -e ADMIN_PASSWORD='change-me' \
#     -v portal-uploads:/app/uploads \
#     portal
#
# Requires BuildKit (default in modern Docker) for the cache mounts below.
#
# Three stages, because the frontend and the backend need entirely different
# toolchains and neither belongs in the runtime image. The wasm toolchain the
# Leptos version needed — cargo-leptos, wasm-bindgen-cli and a version-pinned
# wasm-opt — is gone with it: the browser now gets plain JavaScript.
#
# Schema migrations are compiled into the binary and applied on startup, so no
# migration step is needed here. Likewise no DATABASE_URL at build time: the
# project uses sqlx's runtime-checked queries, not the compile-time `query!`
# macros, so nothing touches a database while building.

ARG RUST_VERSION=1.96
ARG NODE_VERSION=22

# ---------------------------------------------------------------------------
# Stage 1: the frontend bundle
# ---------------------------------------------------------------------------
FROM node:${NODE_VERSION}-bookworm-slim AS frontend

WORKDIR /build/frontend

# Manifests first, so `npm ci` is re-run only when the dependencies actually
# change and not on every source edit.
COPY frontend/package.json frontend/package-lock.json ./
RUN --mount=type=cache,target=/root/.npm,sharing=locked \
    npm ci

COPY frontend/ ./
# `npm run build` is `tsc -b && vite build`: a type error fails the image
# rather than shipping a bundle nobody type-checked.
RUN npm run build

# ---------------------------------------------------------------------------
# Stage 2: the server binary
# ---------------------------------------------------------------------------
FROM rust:${RUST_VERSION}-bookworm AS backend

WORKDIR /build/backend

# `target/` is a cache mount, so it does not bloat this layer — but that also
# means it is gone in later stages. The binary is therefore copied to /out
# inside the same RUN, while the mount is still there.
COPY backend/ ./
RUN --mount=type=cache,target=/usr/local/cargo/registry,sharing=locked \
    --mount=type=cache,target=/build/backend/target,sharing=locked \
    cargo build --release \
    && mkdir -p /out \
    && cp target/release/portal /out/portal

# ---------------------------------------------------------------------------
# Stage 3: runtime
# ---------------------------------------------------------------------------
# bookworm-slim matches the builder's glibc. The binary needs no OpenSSL: sqlx
# is built against rustls, so ca-certificates is the only TLS dependency (used
# when DATABASE_URL points at a Postgres that requires TLS).
FROM debian:bookworm-slim AS runtime

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN useradd --system --uid 10001 --create-home --home-dir /app \
            --shell /usr/sbin/nologin portal

WORKDIR /app

COPY --from=backend  --chown=portal:portal /out/portal            /app/portal
COPY --from=frontend --chown=portal:portal /build/frontend/dist   /app/static

# Uploaded images must outlive the container — mount a volume over this path.
RUN mkdir -p /app/uploads && chown portal:portal /app/uploads
VOLUME ["/app/uploads"]

USER portal

# STATIC_DIR is resolved relative to WORKDIR, hence /app/static. BIND_ADDR is
# 0.0.0.0, not the 127.0.0.1 used for local dev: a loopback bind inside a
# container is unreachable from the host.
#
# No CORS_ORIGINS: the SPA is served from this same origin, so there is no
# cross-origin request to allow. Setting it here would only widen what the
# session cookie travels to.
ENV BIND_ADDR=0.0.0.0:3000 \
    STATIC_DIR=static \
    UPLOADS_DIR=/app/uploads \
    MAX_UPLOAD_BYTES=5242880 \
    RUST_LOG=info

# Supplied at run time, never baked in:
#   DATABASE_URL     (required — the app panics on startup without it)
#   ADMIN_USERNAME / ADMIN_PASSWORD  (seed admin, only used while `users` is empty)
#   SECURE_COOKIE=1  (behind TLS — see DEPLOY.md)

EXPOSE 3000

CMD ["/app/portal"]
