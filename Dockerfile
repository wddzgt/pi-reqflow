ARG NODE_IMAGE=node:22.22.0-bookworm-slim
FROM ${NODE_IMAGE}
ARG PI_VERSION=0.87.1
ARG APP_UID=1000
ARG APP_GID=1000
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates ripgrep fd-find \
    && rm -rf /var/lib/apt/lists/*
RUN npm install --global @earendil-works/pi-coding-agent@${PI_VERSION} \
    && npm cache clean --force
WORKDIR /opt/reqflow
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund
COPY src ./src
COPY web ./web
COPY LICENSE ./LICENSE
COPY examples/demo-app/src ./examples/demo-app/src
COPY examples/demo-app/test ./examples/demo-app/test
COPY examples/demo-app/package.json ./examples/demo-app/package.json
COPY docker/healthcheck.js ./docker/healthcheck.js
RUN mkdir -p /home/node/.pi /projects/.reqflow-workspaces /var/lib/reqflow \
    && chown -R ${APP_UID}:${APP_GID} /home/node /projects /var/lib/reqflow
ENV HOME=/home/node XDG_CACHE_HOME=/tmp/pi-cache TMPDIR=/tmp REQFLOW_STATE_DIR=/var/lib/reqflow
ENV REQFLOW_PI_EXECUTABLE=/usr/local/bin/pi REQFLOW_IMPORT_DIR=/projects/project
USER ${APP_UID}:${APP_GID}
EXPOSE 4173
ENTRYPOINT ["node", "/opt/reqflow/src/cli.js"]
CMD ["web", "--port", "4173", "--host", "0.0.0.0", "--origin", "http://localhost:4173"]
