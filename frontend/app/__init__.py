"""Flask application factory and global app instance."""
import os
from pathlib import Path

from dotenv import load_dotenv
from flask import Flask, render_template

load_dotenv(override=True)

BASE_DIR = Path(__file__).resolve().parents[1]


def _get_env(name: str, default: str = "") -> str:
    value = os.getenv(name, default)
    if value is None:
        return default
    return value.strip()


def _get_env_float(name: str, default: float) -> float:
    value = os.getenv(name)
    if value is None:
        return default
    try:
        return float(str(value).strip())
    except (TypeError, ValueError):
        return default


def create_app() -> Flask:
    """Create and configure the Flask application."""
    app = Flask(
        __name__,
        template_folder=str(BASE_DIR / "templates"),
        static_folder=str(BASE_DIR / "static"),
    )
    app.config["SECRET_KEY"] = _get_env("SECRET_KEY", "dev-secret")
    app.config["FLASK_ENV"] = _get_env("FLASK_ENV", "development")
    app.config["2GIS_API_KEY"] = _get_env("2GIS_API_KEY", "")
    app.config["ENABLE_RASTER_LAYER"] = _get_env("ENABLE_RASTER_LAYER", "false").lower() == "true"
    app.config["TARGET_Z_LAT"] = _get_env_float("TARGET_Z_LAT", 55.731369)
    app.config["TARGET_Z_LNG"] = _get_env_float("TARGET_Z_LNG", 37.614218)
    # TODO: Replace dev defaults with secure secrets and validated 2GIS_API_KEY.

    from .routes import api_bp  # pylint: disable=import-outside-toplevel

    app.register_blueprint(api_bp, url_prefix="/api")

    @app.get("/")
    def index() -> str:
        """Serve the main map UI."""
        target_z = None
        target_lat = app.config.get("TARGET_Z_LAT")
        target_lng = app.config.get("TARGET_Z_LNG")
        if target_lat is not None and target_lng is not None:
            try:
                target_z = {"lat": float(target_lat), "lng": float(target_lng)}
            except (TypeError, ValueError):
                target_z = None

        return render_template(
            "index.html",
            gis_api_key=app.config.get("2GIS_API_KEY", ""),
            enable_raster=app.config.get("ENABLE_RASTER_LAYER", False),
            target_z=target_z,
        )

    return app


# Expose app for gunicorn / wsgi servers.
app = create_app()
