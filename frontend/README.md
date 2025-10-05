# 2GIS Multi-User Routing Skeleton

Minimal Flask + 2GIS playground for the hackathon. Upload JSON scripts, launch optimization stubs, render demo routes on a 2GIS map, ищите точки через Places API и считайте варианты маршрутов на разных видах транспорта через Routing API v7.

## Quick Start

1. Create a virtualenv and install dependencies:
   ```bash
   python -m venv .venv
   .\.venv\Scripts\Activate.ps1
   pip install -r requirements.txt
   ```
2. Copy `.env.example` to `.env` and populate `2GIS_API_KEY` (stub routes are used if empty). Set `ENABLE_RASTER_LAYER=true` только если ваш ключ активирован для RasterJS.
3. Run the dev server:
   ```bash
   flask --app app.main run --debug
   ```

## Docker

```bash
docker build -t 2gis-routing .
docker run --rm -p 8000:8000 --env-file .env 2gis-routing
```

## API Workflow

```bash
curl -X POST http://localhost:8000/api/upload_script \
  -H "Content-Type: application/json" \
  -d @sample.json

curl -X POST http://localhost:8000/api/optimize \
  -H "Content-Type: application/json" \
  -d '{"script_id":"demo-moscow","algorithm":"greedy"}'

curl http://localhost:8000/api/status/<task_id>

curl http://localhost:8000/api/route/demo-moscow

curl "http://localhost:8000/api/places?q=Кремль"

curl "http://localhost:8000/api/point_info?lat=55.75&lng=37.62"

curl -X POST http://localhost:8000/api/quick_route \
  -H "Content-Type: application/json" \
  -d '{"start":{"lat":55.75,"lng":37.60},"destination":{"lat":55.76,"lng":37.62},"transport":"cycling"}'
```

Use `/api/sample_input` for a ready-made payload.

## UI Highlights

- Search панель: вводите название, данные приходят из `/api/places` (2GIS Places API).
- Клик по карте вызывает `/api/point_info` (reverse geocode), показывает название/адрес/координаты; кнопками можно сразу зафиксировать точку как старт или финиш.
- Select «Транспорт» + кнопка «Просчитать маршрут» используют `/api/quick_route`, который делает запрос в Routing API v7 и рисует геометрию вместе с дистанцией и временем (авто, такси, велосипед, пешком и т.д.).
- JSON-панель осталась неизменной: upload → optimize → результат отрисовывается на карте.

## Architecture Notes

- `app/` содержит Flask blueprint, 2GIS клиент, optimization heuristics, in-memory worker и проксирование Places/Reverse geocode/Routing API.
- `templates/index.html` + `static/` host UI с поиском, инспекцией точек, выбором транспорта и управлением маршрутами.
- Optimization defaults to a greedy nearest-neighbor heuristic; swap in your solver via `app/optimization.py`.
- Task execution uses a `ThreadPoolExecutor` stub—replace with sandbox/job runner before accepting untrusted workloads. See in-file TODOs for integration hooks.

## Security Warning

Executing user-supplied scripts is high risk. Run workloads inside hardened sandboxes (Docker + gVisor/Firecracker), drop privileges, apply resource quotas, and never ship API keys into untrusted containers. Review `app/worker.py` comments for a starter checklist.

## Next Steps

- Integrate real 2GIS routing/geocode parameters and handle quota/backoff.
- Register custom optimization strategies (e.g., OR-Tools) in `app/optimization.py`.
- Replace DOM hacks that hide 2GIS UI elements with first-class configuration.
- Persist scripts/tasks in a durable store (Redis/Postgres) if multi-user support is required.
- Доработать deep linking в 2ГИС маршруты, добавить учёт пользовательских предпочтений и опциональную выдачу альтернативных маршрутов.

