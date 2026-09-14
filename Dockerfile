FROM node:20

# Install dependencies for Puppeteer (Chrome)
RUN apt-get update && apt-get install -y \
    wget gnupg libxss1 libasound2 \
    && wget -q -O - https://dl-ssl.google.com/linux/linux_signing_key.pub | apt-key add - \
    && sh -c 'echo "deb [arch=amd64] http://dl.google.com/linux/chrome/deb/ stable main" >> /etc/apt/sources.list.d/google.list' \
    && apt-get update \
    && apt-get install -y google-chrome-stable --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# Set working directory
WORKDIR /app

# Force IPv4 to fix "Client network socket disconnected" error on Hugging Face
ENV NODE_OPTIONS="--dns-result-order=ipv4first"

# Copy package.json and package-lock.json (if available)
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy the rest of the application code
COPY . .

# Ensure the container listens for signals to cleanly stop the polling bot
STOPSIGNAL SIGINT

# Start the bot
CMD ["npm", "start"]
