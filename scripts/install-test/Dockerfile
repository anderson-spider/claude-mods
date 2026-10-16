# A clean machine for `npm run install:test`: Node, the Claude Code CLI package.json pins, and a user with an empty HOME.
# Build from the repository root; the checkout is copied to /src as the marketplace source.
FROM node:24-bookworm-slim
WORKDIR /opt/tools
COPY package.json package-lock.json ./
RUN npm ci && npm cache clean --force
ENV PATH=/opt/tools/node_modules/.bin:$PATH DISABLE_AUTOUPDATER=1
COPY . /src
USER node
WORKDIR /home/node
ENTRYPOINT ["sh", "/src/scripts/install-test/check.sh"]
