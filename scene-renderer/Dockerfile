# HA Scene Renderer add-on image.
#
# Multi-stage build on the Home Assistant Community Apps Debian base image
# (glibc: node-webgl's ANGLE libraries and Chromium both need it; the Alpine
# base images are musl and do not work here).
#
# Build variants (RENDER_BACKEND, default node-webgl):
#   node-webgl  three.js on @onirenaud/node-webgl, no browser. The package
#               compiles a small native addon at install time on Linux, so
#               the build stage carries a compiler; the runtime stage does not.
#   puppeteer   three.js in headless Chromium (SwiftShader). Heavier image;
#               puppeteer + Chromium + its system libraries are installed.
#
# No build.yaml: since the April 2026 BuildKit migration the Dockerfile is
# the single source of truth and the base image is pinned here.
ARG BUILD_FROM=ghcr.io/hassio-addons/debian-base:9.3.0
ARG NODE_VERSION=22.14.0
ARG RENDER_BACKEND=node-webgl

# ---------------------------------------------------------------------------
# Build stage: Node.js + npm dependencies (compiles node-webgl on Linux)
# ---------------------------------------------------------------------------
FROM ${BUILD_FROM} AS build
ARG BUILD_ARCH
ARG NODE_VERSION
ARG RENDER_BACKEND

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        xz-utils \
        python3 \
        g++ \
        make \
        pkg-config \
    && rm -rf /var/lib/apt/lists/*

# Node.js from the official tarball (debian-base ships no Node).
RUN case "${BUILD_ARCH}" in \
        amd64) NODE_ARCH=x64 ;; \
        aarch64) NODE_ARCH=arm64 ;; \
        *) echo "unsupported architecture: ${BUILD_ARCH}" >&2; exit 1 ;; \
    esac \
    && curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${NODE_ARCH}.tar.xz" -o /tmp/node.tar.xz \
    && mkdir -p /usr/local \
    && tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1 \
    && rm /tmp/node.tar.xz \
    && node --version && npm --version

WORKDIR /app
COPY package.json package-lock.json ./
# The puppeteer variant installs the optional puppeteer dependency (and its
# Chromium download); the node-webgl variant skips it.
RUN mkdir -p /root/.cache/puppeteer \
    && if [ "${RENDER_BACKEND}" = "puppeteer" ]; then npm ci; else npm ci --omit=optional; fi

COPY . ./

# ---------------------------------------------------------------------------
# Runtime stage: Node.js runtime + Mesa (software GL for node-webgl) or the
# Chromium system libraries (puppeteer variant).
# ---------------------------------------------------------------------------
FROM ${BUILD_FROM}
ARG BUILD_ARCH
ARG BUILD_VERSION
ARG NODE_VERSION
ARG RENDER_BACKEND

ENV RENDER_BACKEND=${RENDER_BACKEND}

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        xz-utils \
        libgl1 \
        libegl1 \
        libgl1-mesa-dri \
        libgbm1 \
    && if [ "${RENDER_BACKEND}" = "puppeteer" ]; then \
        apt-get install -y --no-install-recommends \
            libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libcups2 \
            libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 \
            libxrandr2 libasound2 libpango-1.0-0 libcairo2 libatspi2.0-0; \
    fi \
    && rm -rf /var/lib/apt/lists/*

RUN case "${BUILD_ARCH}" in \
        amd64) NODE_ARCH=x64 ;; \
        aarch64) NODE_ARCH=arm64 ;; \
        *) echo "unsupported architecture: ${BUILD_ARCH}" >&2; exit 1 ;; \
    esac \
    && curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${NODE_ARCH}.tar.xz" -o /tmp/node.tar.xz \
    && mkdir -p /usr/local \
    && tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1 \
    && rm /tmp/node.tar.xz \
    && node --version

WORKDIR /app
COPY --from=build /app /app
COPY --from=build /root/.cache/puppeteer /root/.cache/puppeteer

# S6 service definition (rootfs) + the service script itself (run.sh).
COPY rootfs /
COPY run.sh /etc/s6-overlay/s6-rc.d/scene-renderer/run
RUN chmod +x /etc/s6-overlay/s6-rc.d/scene-renderer/run

LABEL \
    org.opencontainers.image.title="HA Scene Renderer" \
    org.opencontainers.image.description="Renders a 3D model of your home lit by your real Home Assistant lights and the sun" \
    org.opencontainers.image.source="https://github.com/koneho-ai/ha-scene-renderer" \
    org.opencontainers.image.version="${BUILD_VERSION}"
