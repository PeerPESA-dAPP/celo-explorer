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

# Install dependencies
COPY celo/package*.json ./
RUN npm install

# Copy source
COPY celo/ .

# Load environment variables for Next.js build
COPY config/celo.env .env

# Build Next.js app (standalone output)
# clear
# RUN npm run build
RUN npm ci



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

# Copy standalone server output
COPY --from=build /app/.next/standalone ./

# Copy static assets
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public

EXPOSE 3005

ENV PORT=3005
ENV HOSTNAME="0.0.0.0"

CMD ["node", "server.js"]
