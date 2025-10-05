"""REST API blueprint exposing script upload and optimization endpoints."""
from __future__ import annotations

from copy import deepcopy
from http import HTTPStatus
from pathlib import Path
from typing import Any, Dict, List, Tuple

import json

from flask import Blueprint, jsonify, request, current_app
from pydantic import ValidationError

from .gis_client import reverse_geocode, route_public_transport, route_transport, search_places
from .models import OptimizeRequest, Script
from .worker import script_store, task_manager

api_bp = Blueprint("api", __name__)
FRIENDS_FILE = Path(__file__).resolve().parents[1] / "Friends.json"
FRIEND_TRANSPORT_MODES = {
    "public_transport",
    "car",
    "walking",
    "bicycle",
}



def _load_friends() -> List[Dict[str, Any]]:
    try:
        raw_data = json.loads(FRIENDS_FILE.read_text(encoding="utf-8-sig"))
    except FileNotFoundError:
        return []
    except json.JSONDecodeError:
        return []

    if isinstance(raw_data, dict):
        friends_source = raw_data.get("friends", [])
    elif isinstance(raw_data, list):
        friends_source = raw_data
    else:
        friends_source = []

    normalized: List[Dict[str, Any]] = []
    for item in friends_source:
        if not isinstance(item, dict):
            continue
        friend_id_raw = item.get("friend_id")
        if friend_id_raw is None:
            continue
        friend_id = str(friend_id_raw).strip()
        if not friend_id:
            continue
        try:
            x_coord = float(item["x_coord"])
            y_coord = float(item["y_coord"])
        except (KeyError, TypeError, ValueError):
            continue
        name = str(item.get("name", "")).strip()
        mode = str(item.get("mode", "")).strip() or "car"
        normalized.append(
            {
                "friend_id": friend_id,
                "name": name or f"friend_{friend_id}",
                "x_coord": x_coord,
                "y_coord": y_coord,
                "mode": mode,
            }
        )

    return normalized



def _load_friends_storage() -> Tuple[object, List[Dict[str, Any]]]:
    try:
        raw_text = FRIENDS_FILE.read_text(encoding="utf-8-sig")
    except FileNotFoundError:
        return [], []
    try:
        raw_data = json.loads(raw_text)
    except json.JSONDecodeError:
        return [], []
    if isinstance(raw_data, dict):
        friends_source = raw_data.get("friends")
        if not isinstance(friends_source, list):
            friends_source = []
            raw_data["friends"] = friends_source
        return raw_data, friends_source
    if isinstance(raw_data, list):
        return raw_data, raw_data
    return [], []


def _save_friends_storage(payload: object) -> None:
    FRIENDS_FILE.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8"
    )




def _get_target_z() -> Dict[str, float]:
    lat = current_app.config.get("TARGET_Z_LAT")
    lng = current_app.config.get("TARGET_Z_LNG")
    if lat is None or lng is None:
        return {}
    try:
        return {"lat": float(lat), "lng": float(lng)}
    except (TypeError, ValueError):
        return {}


SAMPLE_SCRIPT: Dict[str, object] = {
    "script_id": "demo-moscow",
    "users": [
        {
            "user_id": "u1",
            "start": {"lat": 55.751244, "lng": 37.618423},
            "prefs": {"note": "Red Square"},
        },
        {
            "user_id": "u2",
            "start": {"address": "Кутузовский проспект, 1, Москва"},
        },
        {
            "user_id": "u3",
            "start": {"address": "Ленинградский проспект, 39, Москва"},
        },
    ],
    "destination": {"address": "Большой театр, Москва"},
    "meta": {"note": "короткий тест"},
}


@api_bp.post("/upload_script")
def upload_script():
    payload = request.get_json(silent=True)
    if payload is None:
        return jsonify({"error": "invalid or missing JSON"}), HTTPStatus.BAD_REQUEST
    try:
        script = Script.parse_obj(payload)
    except ValidationError as exc:
        return jsonify({"error": exc.errors()}), HTTPStatus.BAD_REQUEST

    script_id = script_store.save(script)
    return (
        jsonify({"script_id": script_id, "status": "stored"}),
        HTTPStatus.CREATED,
    )


@api_bp.post("/optimize")
def optimize():
    payload = request.get_json(silent=True)
    if payload is None:
        return jsonify({"error": "invalid or missing JSON"}), HTTPStatus.BAD_REQUEST
    try:
        request_model = OptimizeRequest.parse_obj(payload)
    except ValidationError as exc:
        return jsonify({"error": exc.errors()}), HTTPStatus.BAD_REQUEST

    task_id = task_manager.enqueue(request_model)
    return jsonify({"task_id": task_id, "status": "queued"}), HTTPStatus.ACCEPTED


@api_bp.get("/status/<task_id>")
def status(task_id: str):
    status_obj = task_manager.get_status(task_id)
    if not status_obj:
        return jsonify({"error": "task not found"}), HTTPStatus.NOT_FOUND
    return jsonify(status_obj.dict())


@api_bp.get("/route/<script_id>")
def route(script_id: str):
    geojson = task_manager.get_route(script_id)
    if not geojson:
        return jsonify({"error": "route not ready"}), HTTPStatus.NOT_FOUND
    return jsonify(geojson)


@api_bp.get("/sample_input")
def sample_input():
    return jsonify(deepcopy(SAMPLE_SCRIPT))


@api_bp.get("/friends")
def friends():
    friends_list = _load_friends()
    response: Dict[str, Any] = {"friends": friends_list}
    target_z = _get_target_z()
    if target_z:
        response["target_z"] = target_z
    return jsonify(response)


@api_bp.get("/friends/<friend_id>")
def friend_detail(friend_id: str):
    friend_id_normalized = friend_id.strip()
    if not friend_id_normalized:
        return jsonify({"error": "friend_id is required"}), HTTPStatus.BAD_REQUEST

    friends_list = _load_friends()
    friend = next((item for item in friends_list if item.get("friend_id") == friend_id_normalized), None)
    if friend is None:
        return jsonify({"error": "friend not found"}), HTTPStatus.NOT_FOUND

    response: Dict[str, Any] = dict(friend)
    target_z = _get_target_z()
    if target_z:
        response["target_z"] = target_z
    return jsonify(response)


@api_bp.patch("/friends/<friend_id>")
def update_friend(friend_id: str):
    friend_id_normalized = friend_id.strip()
    if not friend_id_normalized:
        return jsonify({"error": "friend_id is required"}), HTTPStatus.BAD_REQUEST

    payload = request.get_json(silent=True) or {}
    mode_value = payload.get("mode")
    if mode_value is None:
        return jsonify({"error": "mode is required"}), HTTPStatus.BAD_REQUEST

    mode = str(mode_value).strip().lower()
    if mode not in FRIEND_TRANSPORT_MODES:
        return jsonify({"error": "unsupported mode"}), HTTPStatus.BAD_REQUEST

    raw_payload, friends_list = _load_friends_storage()
    target_friend = None
    for friend in friends_list:
        friend_identifier = str(friend.get("friend_id", "")).strip()
        if friend_identifier == friend_id_normalized:
            target_friend = friend
            break

    if target_friend is None:
        return jsonify({"error": "friend not found"}), HTTPStatus.NOT_FOUND

    target_friend["mode"] = mode
    try:
        payload_to_save = raw_payload if isinstance(raw_payload, dict) else friends_list
        _save_friends_storage(payload_to_save)
    except OSError:
        current_app.logger.exception("Failed to write friends data")
        return (
            jsonify({"error": "failed to update friend"}),
            HTTPStatus.INTERNAL_SERVER_ERROR,
        )

    response_data = dict(target_friend)
    response_data["friend_id"] = str(response_data.get("friend_id", friend_id_normalized))
    return jsonify({"friend": response_data}), HTTPStatus.OK


@api_bp.get("/places")
def places_search_route():
    query = (request.args.get("q") or "").strip()
    if not query:
        return jsonify({"error": "query parameter q is required"}), HTTPStatus.BAD_REQUEST
    limit_param = request.args.get("limit")
    try:
        limit = int(limit_param) if limit_param else 5
    except ValueError:
        limit = 5
    results = search_places(query, limit=limit)
    return jsonify({"results": results})


@api_bp.get("/point_info")
def point_info():
    lat_param = request.args.get("lat")
    lng_param = request.args.get("lng")
    if lat_param is None or lng_param is None:
        return jsonify({"error": "lat and lng parameters are required"}), HTTPStatus.BAD_REQUEST
    try:
        lat = float(lat_param)
        lng = float(lng_param)
    except ValueError:
        return jsonify({"error": "lat/lng must be numeric"}), HTTPStatus.BAD_REQUEST

    info = reverse_geocode(lat, lng)
    return jsonify(info)


@api_bp.post("/quick_route")
def quick_route():
    payload = request.get_json(silent=True) or {}
    start = payload.get("start") or {}
    destination = payload.get("destination") or {}

    if "lat" not in start or "lng" not in start or "lat" not in destination or "lng" not in destination:
        return jsonify({"error": "start and destination must include lat/lng"}), HTTPStatus.BAD_REQUEST

    transport = (payload.get("transport") or "driving").strip().lower()

    if transport == "public_transport":
        modes = payload.get("public_transport_modes")
        if not isinstance(modes, list) or not modes:
            modes = ["bus", "tram", "trolleybus", "metro", "shuttle_bus"]
        feature_collection = route_public_transport(
            {"lat": float(start["lat"]), "lng": float(start["lng"])},
            {"lat": float(destination["lat"]), "lng": float(destination["lng"])},
            start_name=payload.get("start_name", "Старт"),
            destination_name=payload.get("destination_name", "Финиш"),
            modes=[str(mode).lower() for mode in modes],
        )
        return jsonify(feature_collection)

    route_mode = (payload.get("route_mode") or "fastest").strip().lower()
    traffic_mode = (payload.get("traffic_mode") or "jam").strip().lower()
    filters = payload.get("filters") if isinstance(payload.get("filters"), list) else []
    output = (payload.get("output") or "detailed").strip().lower()
    need_altitudes = bool(payload.get("need_altitudes"))
    allow_locked_roads = bool(payload.get("allow_locked_roads"))
    params_block = payload.get("params") if isinstance(payload.get("params"), dict) else None
    alternative = payload.get("alternative")
    try:
        alternative_value = int(alternative) if alternative is not None else 0
    except (ValueError, TypeError):
        alternative_value = 0
    utc = payload.get("utc")
    try:
        utc_value = int(utc) if utc is not None else None
    except (ValueError, TypeError):
        utc_value = None

    feature_collection = route_transport(
        {"lat": float(start["lat"]), "lng": float(start["lng"])},
        {"lat": float(destination["lat"]), "lng": float(destination["lng"])},
        transport=transport,
        route_mode=route_mode,
        traffic_mode=traffic_mode,
        filters=filters,
        output=output,
        need_altitudes=need_altitudes,
        alternative=alternative_value,
        allow_locked_roads=allow_locked_roads,
        params=params_block,
        utc=utc_value,
    )
    return jsonify(feature_collection)


# TODO: Plug authentication/quotas before exposing API publicly.

