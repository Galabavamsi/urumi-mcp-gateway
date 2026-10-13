# One Dockerfile for every Node service in the monorepo. Build from the repo root:
#   docker build -f docker/node-service.Dockerfile --build-arg APP=woo-mcp -t urumi/woo-mcp:dev .
# The build stage installs only the selected app + its workspace deps and bundles it with esbuild;
# the runtime stage is just Node + one bundled file, running as the unprivileged `node` user (uid 1000).
ARG NODE_IMAGE=node:24-alpine

FROM ${NODE_IMAGE} AS build
ARG APP
RUN npm install -g pnpm@9.15.0
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY scripts/build-app.mjs scripts/build-app.mjs
COPY packages/ packages/
COPY apps/${APP}/ apps/${APP}/
RUN pnpm install --frozen-lockfile --filter "@urumi/${APP}..." --filter urumi-mcp-gateway
RUN pnpm --filter "@urumi/${APP}" build

FROM ${NODE_IMAGE}
ARG APP
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /repo/apps/${APP}/dist/ ./
USER node
EXPOSE 8080
CMD ["node", "--enable-source-maps", "server.mjs"]
