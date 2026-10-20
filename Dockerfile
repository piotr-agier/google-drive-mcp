FROM node:22-slim AS build

WORKDIR /app

COPY package*.json ./
RUN npm ci --ignore-scripts

COPY tsconfig.json ./
COPY scripts ./scripts
COPY src ./src

RUN npm run build

FROM node:22-slim AS runtime

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts \
    && npm cache clean --force

COPY --from=build --chown=node:node /app/dist ./dist

RUN mkdir -p /config \
    && chown node:node /config

ENV NODE_ENV=production \
    GOOGLE_DRIVE_OAUTH_CREDENTIALS=/config/gcp-oauth.keys.json \
    GOOGLE_DRIVE_MCP_TOKEN_PATH=/config/tokens.json

USER node

EXPOSE 3100

ENTRYPOINT ["node", "dist/index.js"]