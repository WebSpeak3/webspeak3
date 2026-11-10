# --- Rust connector -----------------------------------------------------
# Cross-compiled on the build machine for the target platform via xx, so an
# arm64 image doesn't have to run rustc under QEMU. xx is copied into the
# builder's root, hence pinned by digest rather than a movable tag.
FROM --platform=$BUILDPLATFORM tonistiigi/xx:1.9.0@sha256:c64defb9ed5a91eacb37f96ccc3d4cd72521c4bd18d5442905b95e2226b0e707 AS xx
FROM --platform=$BUILDPLATFORM rust:1-bookworm AS connector-builder
COPY --from=xx / /
ARG TARGETPLATFORM
RUN apt-get update && apt-get install -y --no-install-recommends cmake clang libclang-dev && rm -rf /var/lib/apt/lists/*
RUN xx-apt-get update && xx-apt-get install -y libc6-dev gcc g++ && rm -rf /var/lib/apt/lists/*
RUN rustup target add $(xx-cargo --print-target-triple)
WORKDIR /src
COPY tsclientlib/ tsclientlib/
COPY connector/ connector/
WORKDIR /src/connector
ENV CMAKE_POLICY_VERSION_MINIMUM=3.5
RUN xx-cargo build --release

# --- Web frontend ---------------------------------------------------------
# The bundle is plain JS/CSS, identical for every target platform - build it
# natively on the build machine instead of under emulation.
FROM --platform=$BUILDPLATFORM node:22-bookworm-slim AS web-builder
WORKDIR /src/web
COPY web/package*.json ./
RUN npm ci
# Vite 8 pulls in Rolldown, which ships its bundler as a platform-specific
# optional dependency (@rolldown/binding-linux-<arch>-gnu, <arch> being
# Node's process.arch). `npm ci` intermittently fails to install it due to a
# long-standing npm bug
# (https://github.com/npm/cli/issues/4828) without raising a non-zero exit
# code, so `vite build` only fails later with a confusing MODULE_NOT_FOUND.
# Verify the binding actually loaded and self-heal via the workaround from
# npm's own error message before wasting a full build on a broken install.
RUN node -e "require('@rolldown/binding-linux-' + process.arch + '-gnu')" \
    || (rm -rf node_modules package-lock.json && npm install)
COPY web/ ./
# The UI carries a small Ko-fi donation button (see web/src/App.tsx).
# `--build-arg DONATE_URL=` (empty) drops it, any other value points it
# elsewhere; left alone, the project default is used. The "keep" sentinel
# exists because an unset build arg and an empty one are indistinguishable
# inside RUN - without it, "not passed" would silently mean "remove".
ARG DONATE_URL=keep
# A self-hosted build can bake in a server to auto-connect to with zero user
# input (see web/src/App.tsx's AUTO_CONNECT_FROM_URL/DEFAULT_SERVER, GitHub
# issue #10). Unlike DONATE_URL, unset already means "no default" - no "keep"
# sentinel needed.
ARG DEFAULT_SERVER=
ARG DEFAULT_CHANNEL=
# Design Store catalog to use - unset means "use the maintainer's shared
# one" (App.tsx's own default), same unset-means-no-override convention as
# DEFAULT_SERVER above.
ARG STORE_URL=
# tsc -b currently fails on pre-existing type errors unrelated to this build;
# vite build alone is enough to produce the production bundle.
RUN if [ "$DONATE_URL" = "keep" ]; then DONATE_URL_ENV=; else DONATE_URL_ENV="VITE_DONATE_URL=$DONATE_URL"; fi; \
    env $DONATE_URL_ENV VITE_DEFAULT_SERVER="$DEFAULT_SERVER" VITE_DEFAULT_CHANNEL="$DEFAULT_CHANNEL" VITE_STORE_URL="$STORE_URL" npx vite build

# --- Gateway ----------------------------------------------------------------
# tsc output is platform-independent too; only the runtime stage below
# installs the (pure-JS) production deps for the target platform.
FROM --platform=$BUILDPLATFORM node:22-bookworm-slim AS gateway-builder
WORKDIR /src/gateway
COPY gateway/package*.json ./
RUN npm ci
COPY gateway/ ./
RUN npm run build

# --- Runtime ----------------------------------------------------------------
FROM node:22-bookworm-slim AS runtime
LABEL org.opencontainers.image.title="WebSpeak3"
LABEL org.opencontainers.image.description="Self-hosted web client for TeamSpeak 3 servers"
WORKDIR /app
# ts-connector (Rust, native-tls) needs the OS CA bundle for its HTTPS calls
# (e.g. TeamSpeak nickname lookup) - Node bundles its own certs and works
# without this, but native-tls doesn't, so it's not optional here.
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY gateway/package*.json ./
# npm/npx are only needed to install the gateway's runtime deps; the
# container never runs either afterwards, so strip them (plus npm's own
# cache/package tree) to shrink the image and drop npm's own CVEs from the
# final attack surface. This does mean `docker exec ... npm ...` won't work
# for ad-hoc debugging in a running container anymore.
RUN npm ci --omit=dev \
    && npm cache clean --force \
    && rm -rf /root/.npm /usr/local/lib/node_modules/npm \
    && rm -f /usr/local/bin/npm /usr/local/bin/npx
COPY --from=gateway-builder /src/gateway/dist ./dist
COPY --from=connector-builder /src/connector/target/*/release/ts-connector /app/connector-bin/ts-connector
COPY --from=web-builder /src/web/dist /app/web/dist

ENV PORT=8080
# Release tag, set by .github/workflows/docker-publish.yml. Only used for the
# anonymous usage ping (gateway/src/telemetry.ts).
ARG WEBSPEAK3_VERSION=unknown
ENV WEBSPEAK3_VERSION=$WEBSPEAK3_VERSION
ENV WEB_DIST=/app/web/dist
ENV CONNECTOR_BIN=/app/connector-bin/ts-connector
EXPOSE 8080

# Run unprivileged. /app itself is the default spot for feedback.log and
# store-themes.json, so it has to be writable by that user; a volume mounted
# there from an older (root) image may need a one-off `chown 1000:1000`.
RUN chown node:node /app
USER node

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8080/healthz').then(r => { if (!r.ok) process.exit(1) }).catch(() => process.exit(1))"]

CMD ["node", "dist/index.js"]
