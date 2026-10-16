# syntax=docker/dockerfile:1
# On-site collector image. Runs in the fire-panel network segment (OT VLAN).
FROM python:3.13-slim

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /app
COPY requirements.txt pyproject.toml ./
COPY fs_collector fs_collector
# Optional proxy CA as a build secret (see the root Dockerfile).
RUN --mount=type=secret,id=ca,required=false \
    if [ -f /run/secrets/ca ]; then export PIP_CERT=/run/secrets/ca; fi; \
    pip install --no-cache-dir -r requirements.txt && pip install --no-cache-dir --no-deps . && rm -rf fs_collector

# Outbox lives on a volume so buffered events survive container restarts.
RUN useradd --system --uid 10001 collector && mkdir /data && chown collector /data
USER collector
ENV FS_OUTBOX_PATH=/data/outbox.sqlite3
VOLUME ["/data"]
CMD ["python", "-I", "-m", "fs_collector"]
