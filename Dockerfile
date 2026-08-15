# Use Node.js LTS version
FROM node:20-alpine

# Install dependencies required for Playwright
RUN apk add --no-cache \
    chromium \
    chromium-chromedriver \
    openssl

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci

# Copy application files
COPY . .

# Set environment variables for Playwright
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser \
    PLAYWRIGHT_BROWSERS_PATH=0

# Create necessary directories
RUN mkdir -p public downloads tmp clients

# Expose port
EXPOSE 3000

# Start the application
CMD ["npm", "start"]
