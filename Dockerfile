FROM python:3.11-slim-bookworm

RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    fonts-liberation \
    fonts-dejavu-core \
    fonts-freefont-ttf \
    ca-certificates \
    && (apt-get install -y --no-install-recommends fonts-carlito || true) \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt /app/
RUN pip install --no-cache-dir -r requirements.txt

COPY . /app

ENV CHROMIUM_PATH=/usr/bin/chromium
ENV PYTHONUNBUFFERED=1
ENV HOST=0.0.0.0
ENV PORT=8080

EXPOSE 8080

CMD ["sh", "-c", "gunicorn --preload --bind 0.0.0.0:${PORT:-8080} --workers 2 --threads 4 --timeout 120 --access-logfile - --error-logfile - server:app"]
