# Use Node.js 20 Alpine for ARM64 compatibility and minimal size
FROM node:20-alpine

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install production dependencies only
RUN npm install --only=production && \
    npm cache clean --force

# Copy application source
COPY src/ ./src/

# Create non-root user for security
# The node user already exists in the base image
RUN chown -R node:node /app

# Switch to non-root user
USER node

# Expose port 3002
EXPOSE 3002

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3002/health', (r) => {process.exit(r.statusCode === 200 ? 0 : 1)})"

# Start the server
CMD ["node", "src/server.js"]
