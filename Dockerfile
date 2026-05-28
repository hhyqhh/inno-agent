FROM node:22-bookworm-slim AS build

WORKDIR /app
COPY package.json package-lock.json* ./
COPY tsconfig.base.json ./
COPY apps ./apps
RUN npm install
RUN npm run build

FROM node:22-bookworm-slim AS runtime

WORKDIR /app
ENV NODE_ENV=production
ENV INNO_HOME=/var/lib/inno-agent
ENV INNO_CONFIG_DIR=/etc/inno-agent
ENV INNO_DATA_DIR=/var/lib/inno-agent/data
ENV INNO_SKILLS_DIR=/var/lib/inno-agent/skills
ENV INNO_WORKSPACE_DIR=/srv/inno-workspace
ENV INNO_PORT=3000

COPY --from=build /app /app
RUN mkdir -p /etc/inno-agent /var/lib/inno-agent/data /var/lib/inno-agent/skills /srv/inno-workspace

EXPOSE 3000
CMD ["npm", "run", "server"]
