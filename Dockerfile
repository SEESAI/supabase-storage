FROM node:22 AS builder

WORKDIR /app

COPY package.json package-lock.json ./

RUN --mount=type=secret,id=npmrc,target=/root/.npmrc npm ci

COPY . .

RUN npm run build

FROM node:22-alpine AS runtime

WORKDIR /app

ENV NODE_ENV=production

COPY --from=builder /app/node_modules node_modules

RUN npm prune

COPY --from=builder /app/dist dist

COPY migrations migrations

ARG VERSION=latest

ENV VERSION=$VERSION

EXPOSE 5000

USER node

CMD ["node", "dist/start/server.js"]
