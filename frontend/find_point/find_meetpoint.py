"""Utilities for calculating an optimal meet point for a group of people."""

from __future__ import annotations

import os
from collections import defaultdict
from typing import Dict, Iterable, List, Optional, Sequence, Tuple

import numpy as np

try:  # Optional heavy dependencies.
    import geopandas as gpd
except ImportError:  # pragma: no cover - environment without geopandas.
    gpd = None  # type: ignore

try:  # routingpy provides the OpenRouteService client used by the script.
    from routingpy import ORS
except ImportError:  # pragma: no cover - environment without routingpy.
    ORS = None  # type: ignore

try:
    from shapely.geometry import Point, Polygon
except ImportError:  # pragma: no cover - environment without shapely.
    Point = None  # type: ignore
    Polygon = None  # type: ignore

ORS_API_KEY = os.getenv("ORS_API_KEY")
SERVICE_MATRIX_LIMIT = 3500

__all__ = [
    "MeetpointDependencyError",
    "MeetpointComputationError",
    "create_base_search_area",
    "create_local_search_area",
    "generate_candidates",
    "build_matrix",
    "build_main_vector",
    "find_optimal_meetpoint",
    "compute_best_meetpoint",
]


class MeetpointDependencyError(RuntimeError):
    """Raised when optional dependencies for meetpoint calculation are missing."""


class MeetpointComputationError(RuntimeError):
    """Raised when meetpoint calculation fails for another reason."""


def _build_client(api_key: Optional[str] = None):
    """Return a configured ORS client or raise if dependencies are missing."""

    if ORS is None:
        raise MeetpointDependencyError("routingpy is not installed")

    key = api_key or ORS_API_KEY
    if not key:
        raise MeetpointDependencyError("ORS_API_KEY environment variable is not configured")

    return ORS(
        api_key=key,
        timeout=10,
        retry_timeout=60,
        retry_over_query_limit=True,
        skip_api_error=True,
    )


try:
    client = _build_client()
except MeetpointDependencyError:  # pragma: no cover - best effort fallback at import time.
    client = None


def _ensure_spatial_dependencies() -> None:
    if gpd is None or Point is None or Polygon is None:
        raise MeetpointDependencyError("geopandas and shapely are required for meetpoint calculation")


def create_base_search_area(points: Sequence[Point]):
    """Создаёт расширенный прямоугольный полигон вокруг заданных точек."""

    _ensure_spatial_dependencies()
    if not points:
        raise ValueError("points collection cannot be empty")

    hull = gpd.GeoSeries(list(points), crs="EPSG:4326").unary_union
    if hull.geom_type == "Point":
        hull = hull.buffer(0.01)
    elif hull.geom_type == "LineString":
        hull = hull.buffer(0.01)

    gdf = gpd.GeoDataFrame(geometry=[hull], crs="EPSG:4326")
    crs_utm = gdf.estimate_utm_crs()
    gdf = gdf.to_crs(crs_utm)
    gdf = gdf.buffer(1000)
    return gpd.GeoDataFrame(geometry=gdf.envelope, crs=crs_utm)


def create_local_search_area(point: Point, x_step: float, y_step: float):
    """Создаёт прямоугольный полигон вокруг заданной точки."""
    _ensure_spatial_dependencies()
    gdf = gpd.GeoDataFrame(geometry=[Point(point)], crs="EPSG:4326")
    crs_utm = gdf.estimate_utm_crs()
    gdf = gdf.to_crs(crs_utm)
    buffer_radius = np.ceil(max(x_step, y_step) * 2)
    gdf_buffer = gpd.GeoDataFrame(geometry=gdf.buffer(buffer_radius), crs=crs_utm)
    return gpd.GeoDataFrame(geometry=gdf_buffer.envelope, crs=crs_utm)


def generate_candidates(search_area, people_points: Sequence[Point]):
    """Генерация сетки точек-кандидатов в пределах полигона
    с учётом ограничений на максимальное количество элементов
    в возвращаемой матрице."""
    _ensure_spatial_dependencies()
    minx, miny, maxx, maxy = search_area.iloc[0].geometry.bounds
    width = maxx - minx
    height = maxy - miny

    if not people_points:
        raise ValueError("people_points cannot be empty")

    max_points = SERVICE_MATRIX_LIMIT / len(people_points)
    approx_step = np.sqrt(1 / max_points)
    approx_step = np.clip(approx_step, 0.01, 0.2)
    x_step = width * approx_step
    y_step = height * approx_step

    x_coords = np.arange(minx, maxx, x_step)
    y_coords = np.arange(miny, maxy, y_step)

    candidates = [
        Point(float(x), float(y))
        for x in x_coords
        for y in y_coords
        if search_area.iloc[0].geometry.contains(Point(float(x), float(y)))
    ]

    gdf_candidates = gpd.GeoDataFrame(geometry=candidates, crs=search_area.crs).to_crs(
        "EPSG:4326"
    )
    return list(gdf_candidates.geometry.values), (x_step, y_step)


def build_matrix(client, sources: Sequence[Point], targets: Sequence[Point], profiles: Sequence[str]):
    """Группированный вызов ORS Matrix API по профилямпередвижения."""
    # Группируем индексы людей по профилям
    if client is None:
        raise MeetpointDependencyError("ORS client is not configured")

    profile_groups = defaultdict(list)
    for i, p in enumerate(profiles):
        profile_groups[p].append(i)

    num_people = len(sources)
    num_targets = len(targets)
    durations = np.full((num_people, num_targets), np.inf, dtype=float)

    # Для каждой группы (один тип транспорта — один запрос)
    for profile, idxs in profile_groups.items():
        group_sources = [sources[i] for i in idxs]
        start_points = [[p.x, p.y] for p in group_sources]
        target_points = [[p.x, p.y] for p in targets]

        # Один API-запрос для этой группы
        result = client.matrix(
            locations=start_points + target_points,
            profile=profile,
            sources=list(range(len(start_points))),
            destinations=list(
                range(len(start_points), len(start_points) + len(target_points))
            ),
            metrics=["duration"],
        )

        # Добавляем данные в общую матрицу
        for row_i, person_i in enumerate(idxs):
            durations[person_i, :] = result.durations[row_i]

    return durations


def build_main_vector(client, candidates: Sequence[Point], dest: Point, profile: str):
    """
    Матрица времени от кандидатов до пункта назначения.
    Отличие от основного вызова лишь в формате ответа:
    однномерный массив на который можно перемножить (использовать как вектор).
    Можно было бы интегрировать в build_matrix для минимизации запросов, но так
    функцию проще добавлять отдельно в зависимости от типа встречи: встреча или поездка.
    """
    if client is None:
        raise MeetpointDependencyError("ORS client is not configured")

    start_points = [[p.x, p.y] for p in candidates]
    target_points = [[dest.x, dest.y]]
    result = client.matrix(
        locations=start_points + target_points,
        profile=profile,
        sources=list(range(len(start_points))),
        destinations=[len(start_points)],
        metrics=["duration"],
    )
    return np.array([r[0] for r in result.durations], dtype=float)


def find_optimal_meetpoint(
    matrix_people_to_meetpoint,
    vector_meetpoint_to_dest,
    candidates: Sequence[Point],
    type_of_meetpoint: str,
):
    """Находит оптимальную точку встречи в зависимости от критерия и наличия конечной точки."""
    people_count = matrix_people_to_meetpoint.shape[0]
    if vector_meetpoint_to_dest is None:
        if type_of_meetpoint == "minisum":
            sum_obj = np.sum(matrix_people_to_meetpoint, axis=0)
            sum_obj = np.where(np.isnan(sum_obj), np.inf, sum_obj)
            j_sum = np.argmin(sum_obj)
            return candidates[j_sum]
        elif type_of_meetpoint == "minimax":
            max_obj = np.max(matrix_people_to_meetpoint, axis=0)
            max_obj = np.where(np.isnan(max_obj), np.inf, max_obj)
            j_max = np.argmin(max_obj)
            return candidates[j_max]
        else:
            raise ValueError("type_of_meetpoint должен быть 'minisum' или 'minimax'")

    if type_of_meetpoint == "minisum":
        sum_persons = np.sum(matrix_people_to_meetpoint, axis=0)
        sum_obj = sum_persons + people_count * vector_meetpoint_to_dest
        sum_obj = np.where(np.isnan(sum_obj), np.inf, sum_obj)
        j_sum = np.argmin(sum_obj)
        return candidates[j_sum]
    elif type_of_meetpoint == "minimax":
        max_arr = np.max(matrix_people_to_meetpoint, axis=0)
        max_obj = max_arr + vector_meetpoint_to_dest
        max_obj = np.where(np.isnan(max_obj), np.inf, max_obj)
        j_max = np.argmin(max_obj)
        return candidates[j_max]
    else:
        raise ValueError("type_of_meetpoint должен быть 'minisum' или 'minimax'")


def compute_best_meetpoint(
    people_coordinates: Sequence[Dict[str, float]],
    people_profiles: Sequence[str],
    destination: Optional[Dict[str, float]] = None,
    destination_profile: Optional[str] = None,
    *,
    type_of_meetpoint: str = "minisum",
    api_key: Optional[str] = None,
    client_instance=None,
) -> Tuple[Dict[str, float], Dict[str, object]]:
    """High-level helper that orchestrates the meetpoint search pipeline.

    Returns a tuple ``(coordinates, meta)`` where ``coordinates`` is a mapping with
    ``lat`` and ``lng`` keys and ``meta`` contains diagnostic information.
    """

    if not people_coordinates:
        raise ValueError("people_coordinates must contain at least one entry")
    if len(people_coordinates) != len(people_profiles):
        raise ValueError("people_coordinates and people_profiles length mismatch")

    normalized_type = (type_of_meetpoint or "minisum").lower()
    if normalized_type not in {"minisum", "minimax"}:
        raise ValueError("type_of_meetpoint должен быть 'minisum' или 'minimax'")

    _ensure_spatial_dependencies()

    try:
        points = [Point(float(item["lng"]), float(item["lat"])) for item in people_coordinates]
    except (KeyError, TypeError, ValueError) as exc:
        raise ValueError("invalid people_coordinates entry") from exc

    dest_point: Optional[Point] = None
    if destination is not None:
        try:
            dest_point = Point(float(destination["lng"]), float(destination["lat"]))
        except (KeyError, TypeError, ValueError) as exc:
            raise ValueError("invalid destination coordinates") from exc

    client_to_use = client_instance
    if client_to_use is None:
        if client is not None:
            client_to_use = client
        else:
            client_to_use = _build_client(api_key)

    search_area = create_base_search_area(points)
    candidates, (x_step, y_step) = generate_candidates(search_area, points)
    matrix_people = build_matrix(client_to_use, points, candidates, people_profiles)

    vector_dest = None
    if dest_point is not None:
        dest_profile = destination_profile or "driving-car"
        vector_dest = build_main_vector(client_to_use, candidates, dest_point, dest_profile)

    best_point = find_optimal_meetpoint(
        matrix_people,
        vector_dest,
        candidates,
        normalized_type,
    )

    coordinates = {"lat": float(best_point.y), "lng": float(best_point.x)}
    meta = {
        "candidates": len(candidates),
        "step": {"x": float(x_step), "y": float(y_step)},
        "type_of_meetpoint": normalized_type,
        "destination_included": dest_point is not None,
    }

    return coordinates, meta


if __name__ == "__main__":
    # Блок 1: Выбор режима поиска точки встречи и наличия конечной точки
    type_of_meetpoint = "minimax"  # ["minimax", "minisum"]

    dest_point = Point(38.765574, 55.095276)  # None or Point(lon, lat)
    dest_profile = "driving-car"

    # Блок 2: Определение местоположения людей, их транспорта передвижения и пункта назначения
    people_points = [
        Point(37.802357, 55.668757),
        Point(37.527237, 55.644621),
        Point(37.531429, 55.790507),
        Point(37.700379, 55.903512),
    ]
    people_count = len(people_points)
    people_profiles = [
        "foot-walking",
        "cycling-regular",
        "cycling-regular",
        "driving-car",
    ]

    # Блок 3: Создание прекандидатов точек встречи
    base_search_area = create_base_search_area(people_points)
    pre_candidates, (x_step, y_step) = generate_candidates(
        base_search_area, people_points
    )

    # Блок 4: Расчёт матриц времен
    matrix_people_to_pre_meetpoint = build_matrix(
        client, people_points, pre_candidates, people_profiles
    )
    vector_pre_meetpoint_to_dest = (
        build_main_vector(client, pre_candidates, dest_point, dest_profile)
        if dest_point is not None
        else None
    )

    # Блок 5: Поиск лучшей прекандидатной точки
    best_pre_meetpoint = find_optimal_meetpoint(
        matrix_people_to_pre_meetpoint,
        vector_pre_meetpoint_to_dest,
        pre_candidates,
        type_of_meetpoint,
    )

    # Блок 6: Поиск лучшей точки встречи
    local_search_area = create_local_search_area(best_pre_meetpoint, x_step, y_step)
    candidates, _ = generate_candidates(local_search_area, people_points)
    matrix_people_to_meetpoint = build_matrix(
        client, people_points, candidates, people_profiles
    )
    vector_meetpoint_to_dest = (
        build_main_vector(client, candidates, dest_point, dest_profile)
        if dest_point is not None
        else None
    )
    best_meetpoint = find_optimal_meetpoint(
        matrix_people_to_meetpoint,
        vector_meetpoint_to_dest,
        candidates,
        type_of_meetpoint,
    )
