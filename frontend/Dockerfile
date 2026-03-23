# ── Stage 1: Build ────────────────────────────────────────────────────
FROM node:20-alpine AS build
WORKDIR /app

# Install dependencies first (layer cache optimisation)
COPY frontend/package.json frontend/package-lock.json* ./
RUN npm ci --ignore-scripts

# Copy frontend source and docs (needed for @docs alias in vite.config.ts)
COPY frontend/ .
COPY docs/ /docs/

# Accept optional build-time API base URL override
ARG VITE_API_BASE_URL
ENV VITE_API_BASE_URL=${VITE_API_BASE_URL}

RUN npm run build

# ── Stage 2: Serve ────────────────────────────────────────────────────
FROM nginx:1.27-alpine

# Remove default nginx site
RUN rm /etc/nginx/conf.d/default.conf

COPY frontend/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html

EXPOSE 80

HEALTHCHECK --interval=15s --timeout=3s --retries=3 \
  CMD wget -qO- http://localhost/health || exit 1

CMD ["nginx", "-g", "daemon off;"]
