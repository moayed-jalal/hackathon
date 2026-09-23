FROM node:22-alpine AS build
RUN corepack enable
WORKDIR /app

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY server/package.json server/package.json
COPY web/package.json web/package.json
RUN pnpm install --frozen-lockfile

COPY server server
RUN pnpm --filter @finbridge/server build
RUN pnpm --filter @finbridge/server deploy --prod /out

FROM node:22-alpine AS runner
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /out ./
EXPOSE 4000
CMD ["node", "dist/index.js"]