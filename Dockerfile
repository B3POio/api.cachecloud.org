# Use a lightweight Node.js image
FROM node:18-alpine

# Set working directory
WORKDIR /app

# Copy only necessary files
COPY package.json ./
COPY index.js ./
COPY mail/postmark.js ./mail/

# Install only production dependencies
RUN npm install --only=production

# Start the app
CMD ["node", "index.js"]
