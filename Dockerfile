FROM node:lts

WORKDIR /app
COPY yarn.lock package.json ./
RUN yarn install

COPY . .
EXPOSE 5173
CMD ["yarn", "start", "--host", "0.0.0.0", "--port", "5173"]