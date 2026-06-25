FROM node:22-slim
WORKDIR /app
COPY server.mjs .
ENV PORT=8787 \
    CONTENT_DIR=/content
EXPOSE 8787
CMD ["node", "server.mjs"]
