# Stage 1: Build — compile TypeScript backend + Vite frontend
FROM node:22-bookworm AS build
WORKDIR /app

# Install build tools for native modules (node-pty)
RUN sed -i 's|http://deb.debian.org/debian|http://mirrors.tuna.tsinghua.edu.cn/debian|g' /etc/apt/sources.list.d/debian.sources \
    && apt-get update && apt-get install -y ca-certificates python3 make g++ \
    && sed -i 's|http://mirrors.tuna.tsinghua.edu.cn/debian|https://mirrors.tuna.tsinghua.edu.cn/debian|g' /etc/apt/sources.list.d/debian.sources \
    && rm -rf /var/lib/apt/lists/*

# Copy package manifests for dependency installation
COPY package.json package-lock.json tsconfig.base.json ./
COPY apps/inno-agent/package.json apps/inno-agent/tsconfig.json apps/inno-agent/
COPY apps/inno-agent/web/package.json apps/inno-agent/web/tsconfig.json apps/inno-agent/web/

RUN npm config set registry https://registry.npmmirror.com && npm ci

# Copy source code
COPY apps/inno-agent/src apps/inno-agent/src/
COPY apps/inno-agent/scripts apps/inno-agent/scripts/
COPY apps/inno-agent/web/src apps/inno-agent/web/src/
COPY apps/inno-agent/web/vite.config.ts apps/inno-agent/web/index.html apps/inno-agent/web/

RUN npm run build

# Stage 2: Production runtime — web UI mode
FROM node:22-bookworm AS runtime
WORKDIR /app

# python3 is required at runtime for the pptx→svg preview converter
# (apps/inno-agent/scripts/pptx_to_svg). Stdlib-only, no pip packages.
RUN sed -i 's|http://deb.debian.org/debian|http://mirrors.tuna.tsinghua.edu.cn/debian|g' /etc/apt/sources.list.d/debian.sources \
    && apt-get update && apt-get install -y ca-certificates python3 \
    && sed -i 's|http://mirrors.tuna.tsinghua.edu.cn/debian|https://mirrors.tuna.tsinghua.edu.cn/debian|g' /etc/apt/sources.list.d/debian.sources \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    INNO_HOME=/var/lib/inno-agent \
    INNO_CONFIG_DIR=/etc/inno-agent \
    INNO_DATA_DIR=/var/lib/inno-agent/data \
    INNO_SKILLS_DIR=/var/lib/inno-agent/skills \
    INNO_WORKSPACE_DIR=/srv/inno-workspace \
    INNO_PORT=3000

# Copy the FULL node_modules from build stage (no pruning).
# npm prune --production is unreliable with workspaces: it can drop
# packages like @earendil-works/pi-ai that are depended on by workspace
# packages but nested due to version conflicts with pi-web-ui.
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/apps/inno-agent/node_modules ./apps/inno-agent/node_modules

# Copy compiled artifacts from build stage
COPY --from=build /app/apps/inno-agent/dist ./apps/inno-agent/dist
COPY --from=build /app/apps/inno-agent/web/dist ./apps/inno-agent/web/dist
# Vendored Python pptx→svg converter (not compiled by tsc, copied verbatim)
COPY --from=build /app/apps/inno-agent/scripts ./apps/inno-agent/scripts

#COPY config.example.json /etc/inno-agent/config.json
#RUN mkdir -p /var/lib/inno-agent/data /var/lib/inno-agent/skills /srv/inno-workspace

EXPOSE 3000

CMD ["node", "apps/inno-agent/dist/server.js"]
