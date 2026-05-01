FROM node:20 AS build
WORKDIR /app

# allow passing Vite env at build time
ARG VITE_API_BASE
ENV VITE_API_BASE=${VITE_API_BASE}

# Install deps
COPY package.json package-lock.json ./
RUN npm ci

# Copy source and build
COPY . .
RUN npm run build

FROM nginx:stable-alpine
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
