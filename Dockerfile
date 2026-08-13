# syntax=docker/dockerfile:1.7
#
# Production image for the portal Leptos SSR app.
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
# Schema migrations are compiled into the binary and applied on startup, so no
# migration step is needed here. Likewise no DATABASE_URL at build time: the
# project uses sqlx's runtime-checked queries, not the compile-time `query!`
# macros, so nothing touches a database while building.

# Versions that must agree with the project:
#   RUST_VERSION      — the toolchain this was built and tested with
#   CARGO_LEPTOS      — matches the flake's cargo-leptos
#   WASM_BINDGEN      — MUST equal the `wasm-bindgen` pin in Cargo.toml, or the
#                       build fails with a version-mismatch error
ARG RUST_VERSION=1.96
ARG CARGO_LEPTOS_VERSION=0.3.7
ARG WASM_BINDGEN_VERSION=0.2.121

# ---------------------------------------------------------------------------
# Stage 1: build the server binary and the wasm/JS bundle
# ---------------------------------------------------------------------------
FROM rust:${RUST_VERSION}-bookworm AS builder

ARG CARGO_LEPTOS_VERSION
ARG WASM_BINDGEN_VERSION

# binaryen supplies wasm-opt, which the `wasm-release` profile runs over the
# hydrate bundle. Without it cargo-leptos tries to fetch a binary at build time.
RUN apt-get update \
    && apt-get install -y --no-install-recommends binaryen \
    && rm -rf /var/lib/apt/lists/*

RUN rustup target add wasm32-unknown-unknown

# Tool install is its own layer so it survives every source change. The
# binaries land in /usr/local/cargo/bin, which is not a cache mount and so is
# committed to the layer; only the download cache is mounted.
RUN --mount=type=cache,target=/usr/local/cargo/registry,sharing=locked \
    cargo install cargo-leptos --version ${CARGO_LEPTOS_VERSION} --locked \
    && cargo install wasm-bindgen-cli --version ${WASM_BINDGEN_VERSION} --locked

WORKDIR /build
COPY . .

# `public/` is the configured assets-dir but is empty and untracked by git, so a
# build from a fresh clone would not have it. Creating it keeps cargo-leptos from
# tripping over a missing directory.
RUN mkdir -p public

# `target/` is a cache mount, so it does not bloat this layer — but that also
# means it is gone in later stages. The artifacts are therefore copied to /out
# inside the same RUN, while the mount is still there.
RUN --mount=type=cache,target=/usr/local/cargo/registry,sharing=locked \
    --mount=type=cache,target=/build/target,sharing=locked \
    cargo leptos build --release \
    && mkdir -p /out \
    && cp target/release/portal /out/portal \
    && cp -r target/site /out/site

# ---------------------------------------------------------------------------
# Stage 2: runtime
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

COPY --from=builder --chown=portal:portal /out/portal /app/portal
COPY --from=builder --chown=portal:portal /out/site   /app/site

# Uploaded images must outlive the container — mount a volume over this path.
RUN mkdir -p /app/uploads && chown portal:portal /app/uploads
VOLUME ["/app/uploads"]

USER portal

# LEPTOS_SITE_ROOT is resolved relative to WORKDIR, hence /app/site.
# LEPTOS_SITE_ADDR binds 0.0.0.0, not the 127.0.0.1 used for local dev: a
# loopback bind inside a container is unreachable from the host.
ENV LEPTOS_OUTPUT_NAME=portal \
    LEPTOS_SITE_ROOT=site \
    LEPTOS_SITE_PKG_DIR=pkg \
    LEPTOS_SITE_ADDR=0.0.0.0:3000 \
    LEPTOS_ENV=PROD \
    UPLOADS_DIR=/app/uploads \
    MAX_UPLOAD_BYTES=5242880 \
    RUST_LOG=info

# Supplied at run time, never baked in:
#   DATABASE_URL     (required — the app panics on startup without it)
#   ADMIN_USERNAME / ADMIN_PASSWORD  (seed admin, only used while `users` is empty)

EXPOSE 3000

CMD ["/app/portal"]
