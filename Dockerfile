# ─── Stage 1: Install production dependencies ─────────────────────────
FROM node:20-alpine AS deps

WORKDIR /app

COPY backend/package.json ./
RUN npm install --omit=dev && npm cache clean --force

# ─── Stage 2: Runtime image ───────────────────────────────────────────
FROM node:20-alpine

WORKDIR /app

# Create a non-root user for security
RUN addgroup -S app && adduser -S app -G app

# Copy node_modules from deps stage
COPY --from=deps /app/node_modules ./node_modules

# Copy backend code
COPY backend/ ./backend/

# Copy frontend static files
COPY frontend/ ./frontend/

# Remove dev dependencies if any snuck in
RUN rm -rf node_modules/.cache

# Switch to non-root user
USER app

EXPOSE 3000

ENV NODE_ENV=production

CMD ["node", "backend/server.js"]
