# Single-stage build with Node.js 24
FROM node:24-slim

WORKDIR /app

# Install system dependencies required for Playwright/Camoufox browser, VNC, and dev tools (git)
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    unzip \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libatspi2.0-0 \
    libcups2 \
    libdbus-1-3 \
    libdrm2 \
    libgbm1 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libx11-6 \
    libx11-xcb1 \
    libxcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxrandr2 \
    libxss1 \
    libxtst6 \
    xvfb \
    x11vnc \
    websockify \
    && rm -rf /var/lib/apt/lists/* \
    && apt-get clean

# Copy package manifests and install all dependencies (including dev for build tools)
# Layer is cached unless package.json changes
COPY package*.json ./
RUN npm install --no-audit --no-fund --ignore-scripts \
    && npm cache clean --force

# Download and extract Camoufox browser binary
# Layer is cached unless CAMOUFOX_URL argument changes
# Automatically selects architecture-specific binary if URL not provided
ARG CAMOUFOX_URL
RUN ARCH=$(uname -m) && \
    if [ -z "$CAMOUFOX_URL" ]; then \
    if [ "$ARCH" = "x86_64" ]; then \
    CAMOUFOX_URL="https://github.com/daijro/camoufox/releases/download/v135.0.1-beta.24/camoufox-135.0.1-beta.24-lin.x86_64.zip"; \
    elif [ "$ARCH" = "aarch64" ]; then \
    CAMOUFOX_URL="https://github.com/daijro/camoufox/releases/download/v135.0.1-beta.24/camoufox-135.0.1-beta.24-lin.arm64.zip"; \
    else \
    echo "Unsupported architecture: $ARCH" && exit 1; \
    fi; \
    fi && \
    mkdir -p camoufox-linux && \
    curl -sSL ${CAMOUFOX_URL} -o camoufox.zip && \
    unzip -q camoufox.zip -d /tmp/cf || true && \
    if [ -f /tmp/cf/camoufox ]; then \
    mv /tmp/cf/* camoufox-linux/; \
    else \
    mv /tmp/cf/*/* camoufox-linux/; \
    fi && \
    rm -rf /tmp/cf camoufox.zip && \
    chmod +x /app/camoufox-linux/camoufox

# Copy application source code with proper ownership
# Layer is rebuilt when source code changes
COPY --chown=node:node main.js ./
COPY --chown=node:node vite.config.js ./
COPY --chown=node:node src ./src
COPY --chown=node:node configs ./configs
COPY --chown=node:node scripts ./scripts
COPY --chown=node:node ui ./ui

# Build frontend assets with Vite
# VERSION is passed from docker build-args for version display in UI
ARG VERSION
RUN VERSION=${VERSION} npm run build:ui

# Remove dev dependencies after build to reduce image size
RUN npm prune --omit=dev --ignore-scripts --no-audit --no-fund \
    && npm cache clean --force

# TODO: Temporarily use the root user, and in the future we will switch to the node user
USER root

# Expose application ports
EXPOSE 7860

# Configure runtime environment
ENV NODE_ENV=production \
    CAMOUFOX_EXECUTABLE_PATH=/app/camoufox-linux/camoufox

# Health check for container orchestration platforms
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
    CMD node -e "const port = process.env.PORT || 7860; require('http').get('http://localhost:' + port + '/health', (r) => {process.exit(r.statusCode === 200 ? 0 : 1)}).on('error', () => process.exit(1));" || exit 1

# Start the application server
CMD ["node", "main.js"]
