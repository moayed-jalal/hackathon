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
# This host's network has no IPv6 route (outbound AAAA connects fail with
# ENETUNREACH). Node's Happy Eyeballs dual-stack racing sometimes tries the
# unreachable IPv6 address first, causing intermittent hangs/failures on
# outbound fetches (e.g. the Google OAuth token exchange). Force IPv4 first
# so the working address is always tried first.
ENV NODE_OPTIONS=--dns-result-order=ipv4first
WORKDIR /app
COPY --from=build /out ./
EXPOSE 4000
CMD ["node", "dist/index.js"]