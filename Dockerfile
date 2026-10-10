FROM mcr.microsoft.com/playwright:v1.62.1-noble
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund && mkdir -p /app/data && chown pwuser:pwuser /app/data
COPY --chown=pwuser:pwuser probe.mjs server.mjs pool.mjs drive.mjs executor.mjs muse.mjs deployment.mjs ./
COPY --chown=pwuser:pwuser public ./public
USER pwuser
ENV HOST=0.0.0.0 PORT=8788 DATA_DIR=/app/data ALLOW_LOGIN=0
EXPOSE 8788
CMD ["node", "server.mjs"]
