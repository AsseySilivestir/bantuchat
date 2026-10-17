# ─────────────────────────────────────────────────────────────────────
#  BantuChat — Docker image (pre-built Bantu v1.4.0 binary, ubuntu:24.04)
#
#  No build step — the `bantu` interpreter (Bantu v1.4.0) is committed to
#  the repo root and just COPYd into the image. This makes the Docker
#  build instant + reliable on Render's free tier (no g++/cmake/libffi-dev
#  toolchain to install, ~3 min of build time saved).
#
#  The binary is a dynamically-linked ELF x86-64 that needs glibc ≥ 2.38
#  (built against glibc 2.38), which ubuntu:24.04 (glibc 2.39) provides.
#
#  Build:  docker build -t bantuchat .
#  Run:    docker run -p 8080:8080 -e PORT=8080 -v bantuchat-data:/data bantuchat
# ─────────────────────────────────────────────────────────────────────

FROM ubuntu:24.04 AS runtime

ENV DEBIAN_FRONTEND=noninteractive
ENV TZ=Africa/Dar_es_Salaam
ENV PORT=8080
ENV UDP_PORT=4120
ENV DB_PATH=/data/bantuchat.db

# Runtime libs the bantu binary links against:
#   libsqlite3-0  → libsqlite3.so.0
#   libcurl4      → libcurl.so.4 (pulls libssl3/libcrypto3/libnghttp3/…)
#   libffi8       → libffi.so.8
#   libstdc++6    → libstdc++.so.6
#   ca-certificates + sqlite3 (for the /data disk)
RUN apt-get update && apt-get install -y --no-install-recommends \
        libsqlite3-0 libcurl4 libffi8 libstdc++6 \
        ca-certificates sqlite3 \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /app/public /data && chmod 777 /data

# Copy the pre-built Bantu v1.4.0 interpreter (committed to the repo)
COPY bantu /usr/local/bin/bantu
RUN chmod +x /usr/local/bin/bantu

# Copy the app
WORKDIR /app
COPY server.b /app/server.b
COPY public/ /app/public/
COPY bantu.json /app/bantu.json

EXPOSE 8080

# Pre-flight check so Render logs show clearly if the binary can't run
RUN ldd /usr/local/bin/bantu && /usr/local/bin/bantu --version

# BantuChat listens on $PORT (HTTP+WS) and $UDP_PORT (UDP voice relay)
CMD ["bantu", "run", "server.b"]
