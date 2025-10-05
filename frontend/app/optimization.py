"""Optimization strategies for multi-user routing."""
from __future__ import annotations

import math
from typing import Dict, Iterable, List

from .models import Stop, UserStop


def optimize_multi_user(users: Iterable[UserStop], destination: Stop, algorithm: str = "greedy") -> Dict[str, object]:
    """Return ordered routes for each user.

    The returned structure contains a lightweight description of ordered waypoints.
    Downstream callers convert it into concrete polylines using the routing provider.
    """

    if algorithm == "greedy":
        return _greedy_nearest_neighbor(users, destination)

    # TODO: Plug in OR-Tools or custom solvers via a strategy registry.
    return _greedy_nearest_neighbor(users, destination)


def _greedy_nearest_neighbor(users: Iterable[UserStop], destination: Stop) -> Dict[str, object]:
    destination_coords = destination.to_coordinates()
    plans: List[Dict[str, object]] = []

    for user in users:
        start_coords = user.start.to_coordinates()
        distance = _haversine_distance(start_coords, destination_coords)
        plans.append(
            {
                "user_id": user.user_id,
                "sequence": [start_coords, destination_coords],
                "estimated_distance_km": distance,
                "prefs": user.prefs,
            }
        )

    visit_order = [plan["user_id"] for plan in sorted(plans, key=lambda item: item["estimated_distance_km"])]
    return {
        "algorithm": "greedy",
        "routes": plans,
        "visit_order": visit_order,
    }


def _haversine_distance(a: Dict[str, float], b: Dict[str, float]) -> float:
    """Approximate distance in kilometers between two WGS84 coordinates."""
    lat1, lon1 = math.radians(a["lat"]), math.radians(a["lng"])
    lat2, lon2 = math.radians(b["lat"]), math.radians(b["lng"])
    dlat = lat2 - lat1
    dlon = lon2 - lon1
    hav = math.sin(dlat / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(dlon / 2) ** 2
    earth_radius_km = 6371.0
    return 2 * earth_radius_km * math.asin(math.sqrt(hav))


# TODO: Expose plug-in registration (e.g., register_algorithm("ortools", func)).
