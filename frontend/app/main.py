"""Gunicorn/WSGI entrypoint with Flask CLI support."""
from __future__ import annotations

import sys
from pathlib import Path

if __package__ in {None, ""}:
    project_root = Path(__file__).resolve().parents[1]
    sys.path.insert(0, str(project_root))
    from app import create_app  # type: ignore  # noqa: E402
else:
    from . import create_app

app = create_app()


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=8000, debug=app.config.get("FLASK_ENV") == "development")
22