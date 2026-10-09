# The frontend image: Vite's dev server.
#
# Dev rather than a static build, deliberately: this stack exists to watch a run
# as it is made, and that includes watching the display change under it. `src/` is
# mounted, so an edit reloads in the browser instead of rebuilding an image.
#
# `node_modules` stays INSIDE the image and is never mounted over: the host's
# tree is built against the host's platform, and a bind mount would hide the
# install this image just did.
FROM node:22-slim

WORKDIR /app/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci

# Config and entry point are baked; only `src/` is expected to move often.
COPY frontend/index.html frontend/tsconfig.json frontend/vite.config.ts ./
COPY frontend/src ./src

EXPOSE 5173
# --host: reachable from outside the container, which 127.0.0.1 would not be.
CMD ["npm", "run", "dev", "--", "--host", "0.0.0.0"]
