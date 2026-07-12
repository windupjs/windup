# Windup: Node 22 + system Chromium (multi-arch). Official bench environment.
# Playwright uses the system browser via CHROME_PATH (no browser download);
# alternative supported base: mcr.microsoft.com/playwright:v1.61.0-noble
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
# System chromium via CHROME_PATH: skip Playwright's own browser download.
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
RUN npm install

COPY tsconfig.json tsup.config.ts windup.config.ts ./
COPY src ./src
RUN npm run build

ENV CHROME_PATH=/usr/bin/chromium \
    CHROME_ARGS=--no-sandbox \
    HEADLESS=true

ENTRYPOINT ["node", "dist/cli.js"]
CMD ["run", "saucedemo-login"]
