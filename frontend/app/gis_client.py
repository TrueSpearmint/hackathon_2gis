"""Thin wrapper around the 2GIS HTTP APIs with graceful fallbacks."""
from __future__ import annotations

import logging
import os
from math import asin, cos, radians, sin, sqrt
from typing import Dict, Iterable, List, Optional, Sequence, Tuple
from collections import deque
from datetime import datetime, timedelta

import requests

GEOCODE_URL = "https://catalog.api.2gis.com/3.0/items/geocode"
ROUTING_URL = "https://routing.api.2gis.com/3.0/route"
ROUTING_V7_URL = "https://routing.api.2gis.com/routing/7.0.0/global"
PUBLIC_TRANSPORT_URL = "https://routing.api.2gis.com/public_transport/2.0"
PLACES_URL = "https://catalog.api.2gis.com/3.0/items"
REQUEST_TIMEOUT = 10

logger = logging.getLogger(__name__)

class RoutingRateLimitError(RuntimeError):
    """Raised when routing API rate limit is reached."""


ROUTING_DAILY_LIMIT = int(os.getenv("ROUTING_DAILY_LIMIT", "50"))
ROUTING_MINUTE_LIMIT = int(os.getenv("ROUTING_MINUTE_LIMIT", "5"))
_ROUTING_DAY_WINDOW: deque[datetime] = deque()
_ROUTING_MINUTE_WINDOW: deque[datetime] = deque()


def _check_routing_rate_limit() -> None:
    if ROUTING_DAILY_LIMIT <= 0 and ROUTING_MINUTE_LIMIT <= 0:
        return

    now = datetime.utcnow()

    if ROUTING_DAILY_LIMIT > 0:
        threshold_day = now - timedelta(days=1)
        while _ROUTING_DAY_WINDOW and _ROUTING_DAY_WINDOW[0] < threshold_day:
            _ROUTING_DAY_WINDOW.popleft()
    if ROUTING_MINUTE_LIMIT > 0:
        threshold_minute = now - timedelta(minutes=1)
        while _ROUTING_MINUTE_WINDOW and _ROUTING_MINUTE_WINDOW[0] < threshold_minute:
            _ROUTING_MINUTE_WINDOW.popleft()

    if ROUTING_DAILY_LIMIT > 0 and len(_ROUTING_DAY_WINDOW) >= ROUTING_DAILY_LIMIT:
        raise RoutingRateLimitError("Достигнут дневной лимит запросов маршрутизации")
    if ROUTING_MINUTE_LIMIT > 0 and len(_ROUTING_MINUTE_WINDOW) >= ROUTING_MINUTE_LIMIT:
        raise RoutingRateLimitError("Превышен лимит запросов маршрутизации в минуту")

    _ROUTING_DAY_WINDOW.append(now)
    _ROUTING_MINUTE_WINDOW.append(now)


def _get_api_key() -> str:
    return os.getenv("2GIS_API_KEY", "")


def geocode(address: str) -> Dict[str, float]:
    api_key = _get_api_key()
    if not api_key:
        logger.info("2GIS_API_KEY missing, returning demo coordinates for geocode")
        return {"lat": 55.751244, "lng": 37.618423, "source": "stub"}

    params = {"q": address, "key": api_key, "fields": "items.point"}
    try:
        response = requests.get(GEOCODE_URL, params=params, timeout=REQUEST_TIMEOUT)
        response.raise_for_status()
        data = response.json()
        items = data.get("result", {}).get("items", [])
        if not items:
            raise ValueError("no geocode results")
        point = items[0].get("point") or {}
        return {"lat": point.get("lat"), "lng": point.get("lon"), "source": "2gis"}
    except (requests.RequestException, ValueError) as exc:
        logger.warning("Geocode failed for %s: %s", address, exc)
        return {"lat": 55.751244, "lng": 37.618423, "source": "error-fallback"}


def reverse_geocode(lat: float, lng: float) -> Dict[str, object]:
    api_key = _get_api_key()
    if not api_key:
        logger.info("2GIS_API_KEY missing, returning demo reverse geocode result")
        return {"name": "Точка на карте", "address": "Москва", "point": {"lat": lat, "lng": lng}, "source": "stub"}

    params = {
        "q": f"{lat},{lng}",
        "key": api_key,
        "page": 1,
        "page_size": 1,
        "fields": "items.point,items.address_name",
    }
    try:
        response = requests.get(GEOCODE_URL, params=params, timeout=REQUEST_TIMEOUT)
        response.raise_for_status()
        data = response.json()
        items = data.get("result", {}).get("items", [])
        if not items:
            raise ValueError("no reverse geocode results")
        item = items[0]
        point = item.get("point") or {}
        return {
            "name": item.get("name") or "Неизвестный объект",
            "address": item.get("address_name"),
            "point": {"lat": point.get("lat", lat), "lng": point.get("lon", lng)},
            "source": "2gis",
        }
    except (requests.RequestException, ValueError) as exc:
        logger.warning("Reverse geocode failed for (%s,%s): %s", lat, lng, exc)
        return {"name": "Точка на карте", "address": None, "point": {"lat": lat, "lng": lng}, "source": "error-fallback"}


def route(waypoints: Iterable[Dict[str, float]]) -> Dict[str, object]:
    waypoints_list: List[Dict[str, float]] = list(waypoints)
    if len(waypoints_list) < 2:
        raise ValueError("route requires at least two waypoints")

    api_key = _get_api_key()
    if not api_key:
        logger.info("2GIS_API_KEY missing, echoing straight-line stub route")
        coordinates = [[wp["lng"], wp["lat"]] for wp in waypoints_list]
        return {
            "type": "Feature",
            "geometry": {"type": "LineString", "coordinates": coordinates},
            "properties": {"provider": "stub", "note": "TODO: supply real 2GIS_API_KEY"},
        }

    payload = {
        "points": [{"lon": wp["lng"], "lat": wp["lat"]} for wp in waypoints_list],
        "key": api_key,
        "type": "car",
    }
    try:
        response = requests.post(ROUTING_URL, json=payload, timeout=REQUEST_TIMEOUT)
        response.raise_for_status()
        data = response.json()
        result = data.get("result", {})
        geometries = result.get("geometries") or []
        if geometries:
            geometry = geometries[0]
        else:
            geometry = {"type": "LineString", "coordinates": [[wp["lng"], wp["lat"]] for wp in waypoints_list]}
        return {
            "type": "Feature",
            "geometry": geometry,
            "properties": {"provider": "2gis", "length_meters": result.get("total_distance")},
        }
    except requests.RequestException as exc:
        logger.warning("Route request failed, returning fallback: %s", exc)
        coordinates = [[wp["lng"], wp["lat"]] for wp in waypoints_list]
        return {
            "type": "Feature",
            "geometry": {"type": "LineString", "coordinates": coordinates},
            "properties": {"provider": "error-fallback", "error": str(exc)},
        }


def route_transport(
    start: Dict[str, float],
    destination: Dict[str, float],
    *,
    transport: str = "driving",
    route_mode: str = "fastest",
    traffic_mode: str = "jam",
    locale: str = "ru",
    filters: Optional[List[str]] = None,
    output: str = "detailed",
    need_altitudes: bool = False,
    alternative: int = 0,
    allow_locked_roads: bool = False,
    params: Optional[Dict[str, object]] = None,
    utc: Optional[int] = None,
) -> Dict[str, object]:
    api_key = _get_api_key()
    if not api_key:
        logger.info("2GIS_API_KEY missing, returning stub route for %s", transport)
        return _build_stub_route(start, destination, transport, route_mode, traffic_mode, filters or [])

    point_type = "walking" if transport == "walking" else "stop"
    payload: Dict[str, object] = {
        "points": [
            {"type": point_type, "lon": start["lng"], "lat": start["lat"]},
            {"type": point_type, "lon": destination["lng"], "lat": destination["lat"]},
        ],
        "locale": locale,
        "transport": transport,
        "route_mode": route_mode,
        "output": output,
    }
    if traffic_mode in {"jam", "statistics"}:
        payload["traffic_mode"] = traffic_mode
    if filters:
        payload["filters"] = filters
    if need_altitudes:
        payload["need_altitudes"] = True
    if alternative:
        payload["alternative"] = int(alternative)
    if allow_locked_roads:
        payload["allow_locked_roads"] = True
    if params:
        payload["params"] = params
    if utc is not None:
        payload["utc"] = int(utc)

    params_qs = {"key": api_key}
    try:
        _check_routing_rate_limit()
        response = requests.post(ROUTING_V7_URL, params=params_qs, json=payload, timeout=REQUEST_TIMEOUT)
        response.raise_for_status()
        data = response.json() or {}
        routes_data, meta = _extract_routes(data)
        if not routes_data:
            raise ValueError("empty routing result")

        alt_limit = 1 + max(0, int(alternative or 0))
        routes_data = routes_data[:alt_limit]

        features: List[Dict[str, object]] = []
        primary_summary: Dict[str, object] = {}
        graph: Dict[str, object] = {}

        for idx, route_obj in enumerate(routes_data):
            summary = _extract_summary(route_obj, transport)
            summary.setdefault("source", "2gis")
            geometry = _extract_geometry(route_obj, start, destination)
            feature = {
                "type": "Feature",
                "geometry": geometry,
                "properties": {
                    "provider": "2gis",
                    "transport": transport,
                    "summary": summary,
                    "route_index": idx,
                    "is_alternative": idx > 0,
                },
            }
            features.append(feature)
            if idx == 0:
                primary_summary = summary
                graph = _build_graph(route_obj, start, destination)

        collection = {
            "type": "FeatureCollection",
            "features": features,
            "properties": {
                "summary": primary_summary,
                "graph": graph,
                "details": {
                    "transport": transport,
                    "route_mode": route_mode,
                    "traffic_mode": payload.get("traffic_mode"),
                    "output": output,
                    "filters": filters or [],
                    "need_altitudes": need_altitudes,
                    "alternative": alternative,
                    "allow_locked_roads": allow_locked_roads,
                    "has_alternatives": len(features) > 1,
                },
            },
        }
        if params:
            collection["properties"]["details"]["params"] = params
        if utc is not None:
            collection["properties"]["details"]["utc"] = utc
        if meta and isinstance(meta, dict):
            collection["properties"]["details"]["meta"] = meta
        return collection
    except RoutingRateLimitError as exc:
        logger.warning("Routing rate limit reached, using fallback: %s", exc)
        return _build_error_route(start, destination, transport, route_mode, traffic_mode, filters or [], str(exc))
    except (requests.RequestException, ValueError, TypeError) as exc:
        logger.warning("Route v7 request failed, returning fallback: %s", exc)
        return _build_error_route(start, destination, transport, route_mode, traffic_mode, filters or [], str(exc))


def route_public_transport(
    start: Dict[str, float],
    destination: Dict[str, float],
    *,
    start_name: str = "Старт",
    destination_name: str = "Финиш",
    modes: Optional[List[str]] = None,
    locale: str = "ru",
) -> Dict[str, object]:
    api_key = _get_api_key()
    if not api_key:
        logger.info("2GIS_API_KEY missing, returning stub PT route")
        return _build_stub_route(start, destination, "public_transport", "fastest", "", modes or [])

    transport_modes = modes or ["bus", "tram", "trolleybus", "metro", "shuttle_bus"]
    payload = {
        "locale": locale,
        "source": {"name": start_name or "Старт", "point": {"lat": start["lat"], "lon": start["lng"]}},
        "target": {"name": destination_name or "Финиш", "point": {"lat": destination["lat"], "lon": destination["lng"]}},
        "transport": transport_modes,
    }

    params_qs = {"key": api_key}
    try:
        _check_routing_rate_limit()
        response = requests.post(PUBLIC_TRANSPORT_URL, params=params_qs, json=payload, timeout=REQUEST_TIMEOUT)
        response.raise_for_status()
        routes = response.json() or []
        if not isinstance(routes, list) or not routes:
            raise ValueError("empty PT routing result")

        primary_route = routes[0]
        summary = _extract_pt_summary(primary_route)
        geometry = _extract_pt_geometry(primary_route, start, destination)
        feature = {
            "type": "Feature",
            "geometry": geometry,
            "properties": {
                "provider": "2gis",
                "transport": "public_transport",
                "summary": summary,
                "route_index": 0,
                "is_alternative": False,
            },
        }
        graph = _build_pt_graph(primary_route, start, destination)
        if len(routes) > 1:
            logger.debug("Dropping %s alternative PT routes", len(routes) - 1)

        return {
            "type": "FeatureCollection",
            "features": [feature],
            "properties": {
                "summary": summary,
                "graph": graph,
                "details": {
                    "transport": "public_transport",
                    "modes": transport_modes,
                    "has_alternatives": False,
                },
            },
        }
    except RoutingRateLimitError as exc:
        logger.warning("Routing rate limit reached for PT request, using fallback: %s", exc)
        return _build_error_route(start, destination, "public_transport", "fastest", "", transport_modes, str(exc))
    except (requests.RequestException, ValueError, TypeError) as exc:
        logger.warning("Public transport request failed, returning fallback: %s", exc)
        return _build_error_route(start, destination, "public_transport", "fastest", "", transport_modes, str(exc))


def search_places(query: str, *, limit: int = 5) -> List[Dict[str, object]]:
    api_key = _get_api_key()
    if not api_key:
        logger.info("2GIS_API_KEY missing, returning stubbed place suggestions")
        return [{"id": "stub-red-square", "name": "Красная площадь", "address": "Москва", "point": {"lat": 55.753215, "lng": 37.622504}, "source": "stub"}]

    params = {
        "q": query,
        "key": api_key,
        "page": 1,
        "page_size": max(1, min(limit, 15)),
        "fields": "items.point,items.address_name",
    }
    try:
        response = requests.get(PLACES_URL, params=params, timeout=REQUEST_TIMEOUT)
        response.raise_for_status()
        data = response.json()
        items = data.get("result", {}).get("items", [])
        results: List[Dict[str, object]] = []
        for item in items:
            point = item.get("point") or {}
            if not point:
                continue
            results.append({"id": item.get("id"), "name": item.get("name"), "address": item.get("address_name"), "point": {"lat": point.get("lat"), "lng": point.get("lon")}, "source": "2gis"})
        return results
    except requests.RequestException as exc:
        logger.warning("Place search failed for %s: %s", query, exc)
        return []


def _extract_routes(data: object) -> Tuple[List[Dict[str, object]], Dict[str, object]]:
    if isinstance(data, dict):
        result = data.get("result")
        if isinstance(result, list):
            return result, data.get("query", {})
        if isinstance(result, dict):
            routes = result.get("routes") or result.get("items") or []
            return routes, result
        routes = data.get("routes") or data.get("items")
        if isinstance(routes, list):
            return routes, data
        return [], data
    if isinstance(data, list) and data:
        first = data[0]
        if isinstance(first, dict):
            inner_result = first.get("result")
            if isinstance(inner_result, list):
                return inner_result, first.get("query", {})
            routes = first.get("routes") or first.get("items") or []
            return routes, first
    return [], {}


def _extract_summary(route_obj: Dict[str, object], transport: str) -> Dict[str, object]:
    info = route_obj.get("summary") or route_obj.get("info") or {}
    distance = info.get("distance") or info.get("distance_meters") or info.get("length") or route_obj.get("total_distance")
    duration = info.get("duration") or info.get("time") or info.get("duration_seconds") or route_obj.get("total_duration")
    summary = {
        "distance_m": distance,
        "duration_sec": duration,
        "transport": transport,
        "source": route_obj.get("type") or "2gis",
    }
    summary["altitude_gain"] = info.get("altitude_gain") or info.get("altitude_up")
    summary["altitude_loss"] = info.get("altitude_loss") or info.get("altitude_down")
    if "ui_total_distance" in route_obj:
        summary["ui_total_distance"] = route_obj["ui_total_distance"]
    if "ui_total_duration" in route_obj:
        summary["ui_total_duration"] = route_obj["ui_total_duration"]
    return summary


def _extract_geometry(route_obj: Dict[str, object], start: Dict[str, float], destination: Dict[str, float]) -> Dict[str, object]:
    coordinates: List[List[float]] = []

    def _extend(new_coords: Sequence[Sequence[float]]) -> None:
        for lon, lat in new_coords:
            if not coordinates or coordinates[-1] != [lon, lat]:
                coordinates.append([lon, lat])

    _extend([[start["lng"], start["lat"]]])
    _extend(_collect_geometry_coords(route_obj.get("begin_pedestrian_path")))

    for maneuver in route_obj.get("maneuvers", []):
        path = maneuver.get("outcoming_path") or {}
        _extend(_collect_geometry_coords(path))

    _extend(_collect_geometry_coords(route_obj.get("end_pedestrian_path")))
    _extend([[destination["lng"], destination["lat"]]])

    if len(coordinates) < 2:
        coordinates = [[start["lng"], start["lat"]], [destination["lng"], destination["lat"]]]

    return {"type": "LineString", "coordinates": coordinates}


def _extract_pt_summary(route_obj: Dict[str, object]) -> Dict[str, object]:
    summary = {
        "distance_m": route_obj.get("total_distance"),
        "duration_sec": route_obj.get("total_duration"),
        "transport": "public_transport",
        "transfer_count": route_obj.get("transfer_count"),
        "crossing_count": route_obj.get("crossing_count"),
        "total_walkway_distance": route_obj.get("total_walkway_distance"),
        "modes": route_obj.get("transport") or [],
        "source": "public_transport",
    }
    return summary


def _extract_pt_geometry(route_obj: Dict[str, object], start: Dict[str, float], destination: Dict[str, float]) -> Dict[str, object]:
    coordinates: List[List[float]] = []

    def _extend(new_coords: Sequence[Sequence[float]]) -> None:
        for lon, lat in new_coords:
            if not coordinates or coordinates[-1] != [lon, lat]:
                coordinates.append([lon, lat])

    _extend([[start["lng"], start["lat"]]])

    for movement in route_obj.get("movements", []):
        for alt in movement.get("alternatives", []) or []:
            geometry_list = alt.get("geometry")
            if isinstance(geometry_list, list):
                for geom in geometry_list:
                    _extend(_collect_geometry_coords(geom))
            elif isinstance(geometry_list, dict):
                _extend(_collect_geometry_coords(geometry_list))

    _extend([[destination["lng"], destination["lat"]]])

    if len(coordinates) < 2:
        coordinates = [[start["lng"], start["lat"]], [destination["lng"], destination["lat"]]]

    return {"type": "LineString", "coordinates": coordinates}


def _build_graph(route_obj: Dict[str, object], start: Dict[str, float], destination: Dict[str, float]) -> Dict[str, object]:
    nodes: List[Dict[str, object]] = []
    edges: List[Dict[str, object]] = []

    def add_node(lat: float, lng: float, **extra: object) -> int:
        node_id = len(nodes)
        node = {"id": node_id, "lat": lat, "lng": lng}
        node.update(extra)
        nodes.append(node)
        return node_id

    start_idx = add_node(start["lat"], start["lng"], label="Старт", type="start")
    prev_idx = start_idx

    for step in _iter_steps(route_obj):
        coord = _extract_step_coord(step)
        if not coord:
            continue
        lat, lng = coord
        instruction = step.get("comment") or step.get("instruction") or step.get("outcoming_path_comment")
        if not instruction and step.get("type") == "end":
            instruction = "Финиш"
        distance = _extract_step_distance(step)
        duration = _extract_step_duration(step)
        node_idx = add_node(lat, lng, label=instruction or "Точка маршрута", instruction=instruction, distance_m=distance, duration_sec=duration, type=step.get("type") or "step")
        edges.append({"from": prev_idx, "to": node_idx, "distance_m": distance, "duration_sec": duration, "instruction": instruction})
        prev_idx = node_idx

    dest_idx = add_node(destination["lat"], destination["lng"], label="Финиш", type="end")
    if prev_idx != dest_idx:
        edges.append({"from": prev_idx, "to": dest_idx, "distance_m": _haversine_stub(nodes[prev_idx], destination) * 1000, "duration_sec": None, "instruction": "Финиш"})

    return {"nodes": nodes, "edges": edges}


def _build_pt_graph(route_obj: Dict[str, object], start: Dict[str, float], destination: Dict[str, float]) -> Dict[str, object]:
    nodes: List[Dict[str, object]] = []
    edges: List[Dict[str, object]] = []

    def add_node(lat: float, lng: float, **extra: object) -> int:
        node_id = len(nodes)
        node = {"id": node_id, "lat": lat, "lng": lng}
        node.update(extra)
        nodes.append(node)
        return node_id

    start_idx = add_node(start["lat"], start["lng"], label="Старт", type="start")
    prev_idx = start_idx

    for movement in route_obj.get("movements", []):
        coord = _extract_pt_movement_coord(movement)
        if not coord:
            continue
        lat, lng = coord
        instruction = _describe_pt_movement(movement)
        distance = movement.get("distance")
        duration = movement.get("moving_duration")
        node_idx = add_node(lat, lng, label=instruction or "Участок маршрута", instruction=instruction, distance_m=distance, duration_sec=duration, type=movement.get("type") or "segment")
        edges.append({"from": prev_idx, "to": node_idx, "distance_m": distance, "duration_sec": duration, "instruction": instruction})
        prev_idx = node_idx

    dest_idx = add_node(destination["lat"], destination["lng"], label="Финиш", type="end")
    if prev_idx != dest_idx:
        edges.append({"from": prev_idx, "to": dest_idx, "distance_m": _haversine_stub(nodes[prev_idx], destination) * 1000, "duration_sec": None, "instruction": "Финиш"})

    return {"nodes": nodes, "edges": edges}


def _collect_geometry_coords(source: object) -> List[List[float]]:
    coords: List[List[float]] = []

    if not source:
        return coords

    if isinstance(source, dict) and isinstance(source.get("selection"), str):
        coords.extend(_parse_wkt_linestring(source["selection"]))
    elif isinstance(source, str):
        coords.extend(_parse_wkt_linestring(source))

    geometry = None
    if isinstance(source, dict):
        geometry = source.get("geometry")
    elif not isinstance(source, str):
        geometry = source

    if isinstance(geometry, str):
        coords.extend(_parse_wkt_linestring(geometry))
    elif isinstance(geometry, dict):
        selection = geometry.get("selection")
        if selection:
            coords.extend(_parse_wkt_linestring(selection))
        for key in ("items", "geometries", "lines", "geometry"):
            if key in geometry and isinstance(geometry[key], list):
                for item in geometry[key]:
                    coords.extend(_collect_geometry_coords(item))
    elif isinstance(geometry, list):
        for item in geometry:
            coords.extend(_collect_geometry_coords(item))

    return coords

def _iter_steps(route_obj: Dict[str, object]) -> Iterable[Dict[str, object]]:
    maneuvers = route_obj.get("maneuvers")
    if isinstance(maneuvers, list):
        for maneuver in maneuvers:
            yield maneuver
    legs = route_obj.get("legs") or route_obj.get("items")
    if isinstance(legs, list):
        for leg in legs:
            steps = leg.get("steps") or leg.get("maneuvers") or leg.get("segments")
            if isinstance(steps, list):
                for step in steps:
                    yield step
    instructions = route_obj.get("instructions")
    if isinstance(instructions, list):
        for step in instructions:
            yield step


def _parse_wkt_linestring(selection: str) -> List[List[float]]:
    if not selection:
        return []
    selection = selection.strip()
    if not selection.upper().startswith("LINESTRING"):
        return []
    try:
        inside = selection[selection.index("(") + 1 : selection.rindex(")")]
    except ValueError:
        return []
    coordinates: List[List[float]] = []
    for pair in inside.split(","):
        parts = pair.strip().split()
        if len(parts) >= 2:
            try:
                lon = float(parts[0])
                lat = float(parts[1])
                coordinates.append([lon, lat])
            except ValueError:
                continue
    return coordinates


def _extract_step_coord(step: Dict[str, object]) -> Optional[List[float]]:
    path = step.get("outcoming_path") or {}
    coords = _collect_geometry_coords(path)
    if coords:
        lon, lat = coords[-1]
        return [lat, lon]
    if "point" in step:
        point = step["point"]
        if isinstance(point, dict) and {"lat", "lng"} <= point.keys():
            return [point["lat"], point["lng"]]
        if isinstance(point, dict) and {"lat", "lon"} <= point.keys():
            return [point["lat"], point["lon"]]
    if "position" in step and isinstance(step["position"], dict):
        pos = step["position"]
        if {"lat", "lng"} <= pos.keys():
            return [pos["lat"], pos["lng"]]
    return None


def _extract_step_distance(step: Dict[str, object]) -> Optional[float]:
    path = step.get("outcoming_path") or {}
    if isinstance(path, dict) and isinstance(path.get("distance"), (int, float)):
        return float(path["distance"])
    for key in ("distance", "length", "meters", "distance_meters"):
        if key in step and isinstance(step[key], (int, float)):
            return float(step[key])
    return None


def _extract_step_duration(step: Dict[str, object]) -> Optional[float]:
    path = step.get("outcoming_path") or {}
    if isinstance(path, dict) and isinstance(path.get("duration"), (int, float)):
        return float(path["duration"])
    for key in ("duration", "time", "seconds", "duration_seconds"):
        if key in step and isinstance(step[key], (int, float)):
            return float(step[key])
    return None


def _extract_pt_movement_coord(movement: Dict[str, object]) -> Optional[List[float]]:
    for alt in movement.get("alternatives", []) or []:
        geometry = alt.get("geometry")
        coords = _collect_geometry_coords(geometry)
        if coords:
            lon, lat = coords[-1]
            return [lat, lon]
    waypoint = movement.get("waypoint") or {}
    if isinstance(waypoint, dict):
        point = waypoint.get("point")
        if isinstance(point, dict) and {"lat", "lon"} <= point.keys():
            return [point["lat"], point["lon"]]
    return None


def _describe_pt_movement(movement: Dict[str, object]) -> str:
    movement_type = movement.get("type") or "segment"
    waypoint = movement.get("waypoint") or {}
    comment = waypoint.get("comment") or movement.get("comment")
    name = waypoint.get("name")
    subtype = waypoint.get("subtype")
    routes = []
    for route in movement.get("routes", []) or []:
        if isinstance(route, dict):
            names = route.get("names")
            if isinstance(names, list):
                routes.extend(names)
    parts = []
    if movement_type == "passage":
        parts.append("Проезд")
    elif movement_type == "walkway":
        parts.append("Пешком")
    else:
        parts.append(movement_type.capitalize())
    if subtype:
        parts.append(f"({subtype})")
    if name:
        parts.append(f"через {name}")
    if routes:
        parts.append("маршруты: " + ", ".join(routes))
    if comment:
        parts.append(comment)
    return " ".join(parts)


def _build_stub_route(start: Dict[str, float], destination: Dict[str, float], transport: str, route_mode: str, traffic_mode: str, filters: List[str]) -> Dict[str, object]:
    summary = {
        "distance_m": _haversine_stub(start, destination) * 1000,
        "duration_sec": None,
        "transport": transport,
        "source": "stub",
    }
    return {
        "type": "FeatureCollection",
        "features": [
            {
                "type": "Feature",
                "geometry": {"type": "LineString", "coordinates": [[start["lng"], start["lat"]], [destination["lng"], destination["lat"]]]},
                "properties": {"provider": "stub", "transport": transport, "summary": summary},
            }
        ],
        "properties": {
            "summary": summary,
            "graph": _build_stub_graph(start, destination),
            "details": {
                "transport": transport,
                "route_mode": route_mode,
                "traffic_mode": traffic_mode,
                "filters": filters,
                "source": "stub",
            },
        },
    }


def _build_error_route(start: Dict[str, float], destination: Dict[str, float], transport: str, route_mode: str, traffic_mode: str, filters: List[str], error: str) -> Dict[str, object]:
    summary = {
        "distance_m": _haversine_stub(start, destination) * 1000,
        "duration_sec": None,
        "transport": transport,
        "source": "error",
        "error": error,
    }
    return {
        "type": "FeatureCollection",
        "features": [
            {
                "type": "Feature",
                "geometry": {"type": "LineString", "coordinates": [[start["lng"], start["lat"]], [destination["lng"], destination["lat"]]]},
                "properties": {"provider": "error-fallback", "error": error, "summary": summary},
            }
        ],
        "properties": {
            "summary": summary,
            "graph": _build_stub_graph(start, destination),
            "details": {
                "transport": transport,
                "route_mode": route_mode,
                "traffic_mode": traffic_mode,
                "filters": filters,
                "source": "error",
            },
        },
    }


def _build_stub_graph(start: Dict[str, float], destination: Dict[str, float]) -> Dict[str, object]:
    return {
        "nodes": [
            {"id": 0, "lat": start["lat"], "lng": start["lng"], "label": "Старт", "type": "start"},
            {"id": 1, "lat": destination["lat"], "lng": destination["lng"], "label": "Финиш", "type": "end"},
        ],
        "edges": [
            {
                "from": 0,
                "to": 1,
                "distance_m": _haversine_stub(start, destination) * 1000,
                "duration_sec": None,
                "instruction": "Прямой путь",
            }
        ],
    }


def _haversine_stub(start: Dict[str, float], destination: Dict[str, float]) -> float:
    lat1, lon1 = radians(start["lat"]), radians(start["lng"])
    lat2, lon2 = radians(destination["lat"]), radians(destination["lng"])
    dlat = lat2 - lat1
    dlon = lon2 - lon1
    hav = sin(dlat / 2) ** 2 + cos(lat1) * cos(lat2) * sin(dlon / 2) ** 2
    return 2 * 6371.0 * asin(sqrt(hav))


# TODO: Replace placeholder endpoints/params once official 2GIS routing docs are integrated.






