# Windup: Node 22 + Chromium (multi-arch). Ambiente oficial de bench.
# Build context: packages/windup (compose: context .., dockerfile docker/Dockerfile)
FROM node:22-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        chromium \
        fonts-liberation \
        ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json ./
RUN npm install

COPY tsconfig.json tsup.config.ts windup.config.ts ./
COPY src ./src
RUN npm run build

# --no-sandbox: rodamos como root no container (aceitavel para bench)
ENV CHROME_PATH=/usr/bin/chromium \
    CHROME_ARGS=--no-sandbox \
    HEADLESS=true

ENTRYPOINT ["node", "dist/cli.js"]
CMD ["run", "saucedemo-login"]
