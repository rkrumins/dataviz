# ── deps (shared) ──────────────────────────────────────────────────
FROM node:24-alpine AS deps
WORKDIR /app
COPY frontend/package.json frontend/package-lock.json* ./
RUN npm ci --ignore-scripts

# ── development (dev overlay — source bind-mounted at runtime) ─────
FROM node:24-alpine AS development
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
EXPOSE 5173
CMD ["npm", "run", "dev", "--", "--host", "0.0.0.0", "--port", "5173"]

# ── build (prod static bundle) ─────────────────────────────────────
FROM node:24-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY frontend/ .
COPY docs/ /docs/
ARG VITE_API_BASE_URL
ENV VITE_API_BASE_URL=${VITE_API_BASE_URL}
RUN npm run build

# ── runtime (prod nginx) ───────────────────────────────────────────
FROM nginx:1.31-alpine AS runtime
RUN rm /etc/nginx/conf.d/default.conf
COPY frontend/nginx.conf /etc/nginx/conf.d/default.conf
# connect-src beyond 'self' for the CSP in default.conf: an empty default,
# and the start-up hook that rewrites it from CSP_CONNECT_SRC. The official
# entrypoint runs executable /docker-entrypoint.d/*.sh before nginx starts.
COPY frontend/nginx/00-csp-connect.conf /etc/nginx/conf.d/00-csp-connect.conf
COPY frontend/nginx/40-csp-connect-src.sh /docker-entrypoint.d/40-csp-connect-src.sh
RUN chmod +x /docker-entrypoint.d/40-csp-connect-src.sh
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
HEALTHCHECK --interval=15s --timeout=3s --retries=3 \
  CMD wget -qO- http://127.0.0.1/health || exit 1
CMD ["nginx", "-g", "daemon off;"]
