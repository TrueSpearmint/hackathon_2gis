FROM python:3.11-slim

WORKDIR /app
ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

# TODO: Supply 2GIS_API_KEY at runtime (e.g., docker run --env-file .env).
CMD ["gunicorn", "app.main:app", "--bind", "0.0.0.0:8000"]
