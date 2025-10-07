FROM mcr.microsoft.com/playwright:v1.56.0-jammy
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY index.js ./
EXPOSE 8080
CMD ["npm","start"]
