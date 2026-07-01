# syntax=docker/dockerfile:1

# ===== Build Stage =====
FROM node:20-alpine AS build

WORKDIR /app

# System deps for node-gyp and native modules
# RUN apk add --no-cache \
#     python3 \
#     make \
#     g++ \
#     eudev-dev \
#     libusb-dev \
#     pkgconf \
#     linux-headers

# Install dependencies (npm ci for reproducible, lockfile-exact installs;
# cache mount keeps npm's download cache across builds without bloating the image)
COPY celo/package*.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci

# Copy source
COPY celo/ .

# Load environment variables for Next.js build
COPY config/celo.env .env

# Build Next.js app (standalone output)
RUN npm run build



# ===== Production Stage =====
FROM node:20-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production


# System deps for node-gyp and native modules
# RUN apk add --no-cache \
#     python3 \
#     make \
#     g++ \
#     eudev-dev \
#     libusb-dev \
#     pkgconf \
#     linux-headers

# Run as non-root
RUN addgroup --system --gid 1001 nodejs \
    && adduser --system --uid 1001 nextjs

# Copy standalone server output
COPY --from=build --chown=nextjs:nodejs /app/.next/standalone ./

# Copy static assets
COPY --from=build --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=build --chown=nextjs:nodejs /app/public ./public

USER nextjs

EXPOSE 3005

ENV PORT=3005
ENV HOSTNAME="0.0.0.0"

CMD ["node", "server.js"]
