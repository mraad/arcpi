# syntax=docker/dockerfile:1
# arcpi image: Node (runs the launcher's TypeScript directly), pi and RTK.
# The checkout is mounted, not copied (see compose.yaml).
FROM scratch AS rtk-amd64
ADD --checksum=sha256:5028d3b19a8f0990d30fec9fbb07e32782bc5698e618fb1861aad8a9ccba4eb5 https://github.com/rtk-ai/rtk/releases/download/v0.51.0/rtk-x86_64-unknown-linux-musl.tar.gz /rtk.tar.gz
FROM scratch AS rtk-arm64
ADD --checksum=sha256:8d6d1aad9e69b42481eda7039507d1f7ee93698f87713cecd873d287c1931632 https://github.com/rtk-ai/rtk/releases/download/v0.51.0/rtk-aarch64-unknown-linux-gnu.tar.gz /rtk.tar.gz
FROM rtk-${TARGETARCH} AS rtk

FROM node:26-trixie-slim
ARG PI_VERSION=1.1.0
COPY --from=rtk /rtk.tar.gz /tmp/rtk.tar.gz
# pi downloads fd and ripgrep into its agent directory when missing; install them instead.
RUN apt-get update && apt-get install -y --no-install-recommends fd-find ripgrep \
  && rm -rf /var/lib/apt/lists/* \
  && tar -xzf /tmp/rtk.tar.gz -C /usr/local/bin rtk && rm /tmp/rtk.tar.gz \
  && rtk --version \
  && npm install -g --ignore-scripts "@earendil-works/pi-coding-agent@${PI_VERSION}" && npm cache clean --force
# Owned by node, so a volume mounted here (compose.map.yaml) is writable.
RUN mkdir -p /home/node/.pi/agent/bin && chown -R node:node /home/node/.pi
USER node
WORKDIR /work/arcpi
