# ─────────────────────────────────────────────────────────────────────
#  BantuChat — Docker image (Ubuntu 22.04, builds Bantu from source)
#
#  Produces a self-contained image that runs the BantuChat server
#  (Bantu v1.4.0 interpreter + server.b) on port $PORT.
#
#  Build:  docker build -t bantuchat .
#  Run:    docker run -p 8080:8080 -e PORT=8080 -v bantuchat-data:/data bantuchat
# ─────────────────────────────────────────────────────────────────────

FROM ubuntu:22.04 AS builder

ENV DEBIAN_FRONTEND=noninteractive
ENV TZ=Africa/Dar_es_Salaam

# Build deps: g++ (C++17), sqlite3 + curl dev headers, make, git (to clone Bantu), ca-certs
RUN apt-get update && apt-get install -y --no-install-recommends \
        build-essential g++ gcc make git ca-certificates \
        libsqlite3-dev libcurl4-openssl-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /build

# Clone the Bantu v1.4.0 toolchain (interpreter source) and build the static binary.
# v1.4.0 ships as a single ~3.8 MB binary with zero runtime deps beyond libsqlite3 + libcurl.
RUN git clone --depth 1 --branch main https://github.com/AsseySilivestir/Bantu.git bantu-src \
    && cd bantu-src/bantu-src/compiler \
    && bash build.sh \
    && cp build/bantu /usr/local/bin/bantu \
    && bantu --version

# ─────────────────────────────────────────────────────────────────────
#  Runtime stage — small image, just the binary + the app + runtime libs
# ─────────────────────────────────────────────────────────────────────
FROM ubuntu:22.04 AS runtime

ENV DEBIAN_FRONTEND=noninteractive
ENV TZ=Africa/Dar_es_Salaam
ENV PORT=8080
ENV UDP_PORT=4120

RUN apt-get update && apt-get install -y --no-install-recommends \
        libsqlite3-0 libcurl4 ca-certificates sqlite3 \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /app/public /data

# Copy the freshly-built Bantu interpreter
COPY --from=builder /usr/local/bin/bantu /usr/local/bin/bantu

# Copy the app
WORKDIR /app
COPY server.b /app/server.b
COPY public/ /app/public/
COPY bantu.json /app/bantu.json

# SQLite database lives on a Render disk mounted at /data (persists across deploys)
ENV DB_PATH=/data/bantuchat.db
RUN mkdir -p /data && chmod 777 /data

EXPOSE 8080 4120/udp

# Pre-flight check so Render logs show clearly if the binary can't run
RUN ldd /usr/local/bin/bantu && /usr/local/bin/bantu --version

# BantuChat listens on $PORT (HTTP+WS) and $UDP_PORT (UDP voice relay)
CMD ["bantu", "run", "server.b"]
