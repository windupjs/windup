# Spike RubberDuck: Node 22 + Chromium (multi-arch: funciona em amd64 e arm64)
FROM node:22-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        chromium \
        fonts-liberation \
        ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src

# --no-sandbox: rodamos como root no container (aceitável para a spike)
ENV CHROME_PATH=/usr/bin/chromium \
    CHROME_ARGS=--no-sandbox \
    HEADLESS=true

ENTRYPOINT ["npm", "run", "spike", "--"]
CMD ["run", "saucedemo-login"]
