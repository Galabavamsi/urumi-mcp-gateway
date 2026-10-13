# Dashboard image: build the React SPA with Node, then serve the static files with unprivileged nginx.
# Build from the repo root:
#   docker build -f docker/dashboard.Dockerfile -t urumi/dashboard:dev --network=host .
# The runtime image holds only nginx, apps/dashboard/nginx.conf and the built files: no Node, no sources.
# It runs as uid 101 on :8080 and works with a read-only root filesystem when an emptyDir is mounted at
# /tmp (required) and optionally /var/cache/nginx (see the header of apps/dashboard/nginx.conf).
# Both bases are pinned to an exact release; the Node one matches docker/node-service.Dockerfile.
ARG NODE_IMAGE=node:24.21.0-alpine3.24
ARG NGINX_IMAGE=nginxinc/nginx-unprivileged:1.30.5-alpine3.24

FROM ${NODE_IMAGE} AS build
RUN npm install -g pnpm@9.15.0
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/dashboard/ apps/dashboard/
RUN pnpm install --frozen-lockfile --filter "@urumi/dashboard..."
RUN pnpm --filter @urumi/dashboard build

FROM ${NGINX_IMAGE}
COPY apps/dashboard/nginx.conf /etc/nginx/nginx.conf
COPY --from=build /repo/apps/dashboard/dist/ /usr/share/nginx/html/
USER 101
EXPOSE 8080
# Run nginx directly. The base image's entrypoint scripts rewrite config files at startup (IPv6 listen,
# env templates), which a read-only root filesystem forbids and which we don't use.
ENTRYPOINT ["nginx"]
CMD ["-g", "daemon off;"]
