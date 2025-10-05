"""Service helpers for calculating the shared meet point."""

from __future__ import annotations

import importlib
import logging
import math
from dataclasses import dataclass
from typing import Dict, List, Optional, Sequence, Tuple


logger = logging.getLogger(__name__)


try:
    meetpoint_module = importlib.import_module("find_point.find_meetpoint")
    MEETPOINT_IMPORT_ERROR = None
except ImportError as exc:  # pragma: no cover - optional dependency path.
    meetpoint_module = None
    MEETPOINT_IMPORT_ERROR = str(exc)


DEFAULT_MEETPOINT_TYPE = "minisum"


_TRANSPORT_TO_PROFILE = {
    "car": "driving-car",
    "driving": "driving-car",
    "taxi": "driving-car",
    "public_transport": "driving-car",
    "walking": "foot-walking",
    "pedestrian": "foot-walking",
    "foot": "foot-walking",
    "bicycle": "cycling-regular",
    "bike": "cycling-regular",
    "cycling": "cycling-regular",
    "scooter": "cycling-regular",
    "motorcycle": "driving-car",
    "truck": "driving-hgv",
    "hgv": "driving-hgv",
    "emergency": "driving-car",
}

DEFAULT_PROFILE = "driving-car"


@dataclass
class MeetpointResult:
    point: Dict[str, float]
    meta: Dict[str, object]


def _map_transport_to_profile(mode: Optional[str]) -> str:
    if not mode:
        return DEFAULT_PROFILE
    return _TRANSPORT_TO_PROFILE.get(mode.lower(), DEFAULT_PROFILE)


def _normalize_coordinates(entry: Dict[str, object]) -> Tuple[float, float]:
    try:
        lat = float(entry["lat"])
        lng = float(entry["lng"])
    except (KeyError, TypeError, ValueError) as exc:
        raise ValueError("invalid coordinate entry") from exc
    return lat, lng


def _geometric_median(points: Sequence[Tuple[float, float]], *, max_iterations: int = 80, tolerance: float = 1e-6) -> Dict[str, float]:
    if not points:
        raise ValueError("geometric median requires at least one point")
    if len(points) == 1:
        lat, lng = points[0]
        return {"lat": lat, "lng": lng}

    current_lat = sum(lat for lat, _ in points) / len(points)
    current_lng = sum(lng for _, lng in points) / len(points)
    epsilon = 1e-12

    for _ in range(max_iterations):
        num_lat = 0.0
        num_lng = 0.0
        denom = 0.0
        coincident = 0

        for lat, lng in points:
            diff_lat = current_lat - lat
            diff_lng = current_lng - lng
            distance = math.hypot(diff_lat, diff_lng)
            if distance < epsilon:
                coincident += 1
                num_lat += lat
                num_lng += lng
                denom += 1.0
            else:
                weight = 1.0 / distance
                num_lat += lat * weight
                num_lng += lng * weight
                denom += weight

        if denom == 0:
            break

        next_lat = num_lat / denom
        next_lng = num_lng / denom
        if math.hypot(next_lat - current_lat, next_lng - current_lng) < tolerance:
            current_lat, current_lng = next_lat, next_lng
            break
        current_lat, current_lng = next_lat, next_lng

    return {"lat": current_lat, "lng": current_lng}


def calculate_meetpoint(
    participants: Sequence[Dict[str, object]],
    *,
    destination: Optional[Dict[str, object]] = None,
    type_of_meetpoint: str = DEFAULT_MEETPOINT_TYPE,
) -> MeetpointResult:
    """Compute the optimal meet point for participants using the Find_meetpoint script.

    Falls back to the geometric median if the heavy dependencies are unavailable or the
    external service returns an error.
    """

    if not participants:
        raise ValueError("participants must be a non-empty list")

    coordinates: List[Tuple[float, float]] = []
    profiles: List[str] = []

    for entry in participants:
        lat, lng = _normalize_coordinates(entry)
        coordinates.append((lat, lng))
        profiles.append(_map_transport_to_profile(entry.get("transport")))

    dest_payload: Optional[Dict[str, float]] = None
    dest_profile: Optional[str] = None
    if destination:
        dest_lat, dest_lng = _normalize_coordinates(destination)
        dest_payload = {"lat": dest_lat, "lng": dest_lng}
        dest_profile = _map_transport_to_profile(destination.get("transport"))

    normalized_type = (type_of_meetpoint or DEFAULT_MEETPOINT_TYPE).lower()
    if normalized_type not in {"minisum", "minimax"}:
        raise ValueError("type_of_meetpoint must be 'minisum' or 'minimax'")

    fallback_used = False
    fallback_reason: Optional[str] = None
    module_meta: Dict[str, object] = {}

    if meetpoint_module and hasattr(meetpoint_module, "compute_best_meetpoint"):
        try:
            coords, module_meta = meetpoint_module.compute_best_meetpoint(
                people_coordinates=[{"lat": lat, "lng": lng} for lat, lng in coordinates],
                people_profiles=profiles,
                destination=dest_payload,
                destination_profile=dest_profile,
                type_of_meetpoint=normalized_type,
            )
            point = {"lat": float(coords["lat"]), "lng": float(coords["lng"])}
            source = "find_meetpoint"
        except getattr(meetpoint_module, "MeetpointDependencyError", RuntimeError) as exc:
            fallback_used = True
            fallback_reason = str(exc)
            point = _geometric_median(coordinates)
            source = "geometric_median"
        except Exception as exc:  # pylint: disable=broad-except
            fallback_used = True
            fallback_reason = str(exc)
            logger.exception("Meetpoint calculation failed, falling back to geometric median", exc_info=exc)
            point = _geometric_median(coordinates)
            source = "geometric_median"
    else:
        fallback_used = True
        fallback_reason = MEETPOINT_IMPORT_ERROR or "find_meetpoint module unavailable"
        point = _geometric_median(coordinates)
        source = "geometric_median"

    meta: Dict[str, object] = {
        "source": source,
        "fallback_used": fallback_used,
        "participant_count": len(coordinates),
        "type_of_meetpoint": normalized_type,
    }
    if dest_payload is not None:
        meta["destination_included"] = True
    if module_meta:
        meta["module"] = module_meta
    if fallback_reason:
        meta["fallback_reason"] = fallback_reason

    return MeetpointResult(point=point, meta=meta)

