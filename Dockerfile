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
#   WASM_OPT          — binaryen release cargo-leptos downloads for wasm-opt. It
#                       must be new enough to understand the two-table (funcref
#                       + externref) module wasm-bindgen 0.2.121 emits; see the
#                       note on the builder stage below.
ARG RUST_VERSION=1.96
ARG CARGO_LEPTOS_VERSION=0.3.7
ARG WASM_BINDGEN_VERSION=0.2.121
ARG WASM_OPT_VERSION=version_123

# ---------------------------------------------------------------------------
# Stage 1: build the server binary and the wasm/JS bundle
# ---------------------------------------------------------------------------
FROM rust:${RUST_VERSION}-bookworm AS builder

ARG CARGO_LEPTOS_VERSION
ARG WASM_BINDGEN_VERSION
ARG WASM_OPT_VERSION

# wasm-opt post-processes the hydrate bundle for the `wasm-release` profile, and
# its version is not a free choice. Debian's `binaryen` package is 108 (2022),
# which predates the layout wasm-bindgen 0.2.121 emits: it rewrites the module
# with two tables (funcref + externref) but leaves the `__wbindgen_externrefs`
# export pointing at table 0 — the funcref table, which it also caps at
# max == initial. The JS glue then calls `__wbindgen_externrefs.grow(4)` during
# `__wbindgen_init_externref_table`, that throws `RangeError: failed to grow
# table`, and hydration dies before a single event handler is attached. The page
# still renders (it is server-side rendered) so the only symptom is that nothing
# on it works — most visibly, the login form posts nothing and reports nothing.
#
# So: do NOT install binaryen from apt. cargo-leptos fetches a matching wasm-opt
# itself; pinning it here keeps the build reproducible.
ENV LEPTOS_WASM_OPT_VERSION=${WASM_OPT_VERSION}

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
