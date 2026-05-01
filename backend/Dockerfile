FROM node:20-slim

WORKDIR /app

# Install git (required by worker runtime for cloning) and ca-certificates
RUN apt-get update && apt-get install -y git ca-certificates && rm -rf /var/lib/apt/lists/*

# Install dependencies (including dev tools used at runtime like tsx)
COPY package.json package-lock.json ./
RUN npm ci

# Copy source
COPY . .

# Generate Prisma client
RUN npx prisma generate || true

ENV PORT=4000
EXPOSE 4000

CMD ["npm", "run", "start"]
