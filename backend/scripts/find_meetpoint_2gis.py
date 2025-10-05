import json
import os
import time
from collections import defaultdict
from typing import Any, Dict, List

import geopandas as gpd
import numpy as np
import requests
from shapely.geometry import Point, Polygon

from find_transport_stop_near_meetpoint import find_transport_stop_near_meetpoint

# ====================== НАСТРОЙКИ ==========================
GIS2_API_KEY = os.getenv("GIS2_API_KEY")
SERVICE_MATRIX_LIMIT = 3500


# ===========================================================
#     КЛАСС РАСЧЁТА МАТРИЦЫ РАССТОЯНИЙ ЧЕРЕЗ API 2GIS
# ===========================================================
class DistanceMatrixCalculator:
    """Класс для расчёта матриц расстояний через 2GIS API."""

    def __init__(self, api_key: str):
        self.api_key = api_key
        self.url_sync = "https://routing.api.2gis.com/get_dist_matrix"
        self.max_sources = 10  # Новый лимит API 2GIS
        self.max_targets = 10  # Новый лимит API 2GIS

    def _process_batch(
        self, sources: List[Dict], targets: List[Dict]
    ) -> Dict[str, Any]:
        """Выполняет один запрос к API."""
        if len(sources) > self.max_sources or len(targets) > self.max_targets:
            raise ValueError(f"Превышен лимит: {len(sources)}×{len(targets)} > 10×10")

        payload = {
            "points": sources + targets,
            "sources": list(range(len(sources))),
            "targets": [len(sources) + i for i in range(len(targets))],
        }

        params = {"key": self.api_key, "version": "2.0"}
        headers = {"Content-Type": "application/json"}

        response = requests.post(
            self.url_sync, params=params, headers=headers, json=payload
        )
        if response.status_code == 200:
            return response.json()
        else:
            raise RuntimeError(
                f"Ошибка API 2GIS: {response.status_code} - {response.text}"
            )

    def calculate_matrix(
        self, sources: List[Dict], targets: List[Dict]
    ) -> Dict[str, Any]:
        """Главная функция: возвращает все маршруты."""
        if len(sources) <= self.max_sources and len(targets) <= self.max_targets:
            return self._process_batch(sources, targets)
        else:
            return self._process_large_matrix(sources, targets)

    def _process_large_matrix(
        self, sources: List[Dict], targets: List[Dict]
    ) -> Dict[str, Any]:
        """Разбивает большую матрицу на пакеты (<=100 комбинаций)."""
        all_routes = []
        total_time = 0
        batch_count = 0

        for s_start in range(0, len(sources)):
            for t_start in range(0, len(targets)):
                # определяем динамически размер пакета, чтобы не превышать 100 пар
                for s_end in range(s_start + 1, min(len(sources), s_start + 10) + 1):
                    for t_end in range(
                        t_start + 1, min(len(targets), t_start + 10) + 1
                    ):
                        s_batch = sources[s_start:s_end]
                        t_batch = targets[t_start:t_end]

                        # если комбинаций >100 — уменьшаем пакет
                        if len(s_batch) * len(t_batch) > 100:
                            t_batch = t_batch[: max(1, 100 // len(s_batch))]

                        batch_count += 1
                        try:
                            batch = self._process_batch(s_batch, t_batch)
                            for r in batch.get("routes", []):
                                r["source_id"] = s_start + r["source_id"]
                                r["target_id"] = t_start + (
                                    r["target_id"] - len(s_batch)
                                )
                                all_routes.append(r)
                            total_time += batch.get("generation_time", 0)
                        except Exception as e:
                            print(f"Ошибка пакета {batch_count}: {e}")

        return {
            "routes": all_routes,
            "generation_time": total_time,
            "metadata": {
                "sources": len(sources),
                "targets": len(targets),
                "batches": batch_count,
            },
        }


# ===========================================================
#     ВСПОМОГАТЕЛЬНЫЕ ГЕО-ФУНКЦИИ
# ===========================================================
def create_base_search_area(points):
    """Создаёт расширенный прямоугольный полигон вокруг заданных точек."""
    gdf = gpd.GeoDataFrame(
        geometry=[Polygon([(p.x, p.y) for p in points])], crs="EPSG:4326"
    )
    crs_utm = gdf.estimate_utm_crs()
    gdf = gdf.to_crs(crs_utm)
    gdf = gdf.buffer(1000)
    return gpd.GeoDataFrame(geometry=gdf.envelope, crs=crs_utm)


def create_local_search_area(point, x_step, y_step):
    """Создаёт прямоугольный полигон вокруг заданной точки."""
    gdf = gpd.GeoDataFrame(geometry=[Point(point)], crs="EPSG:4326")
    crs_utm = gdf.estimate_utm_crs()
    gdf = gdf.to_crs(crs_utm)
    buffer_radius = np.ceil(max(x_step, y_step) * 2)
    gdf_buffer = gpd.GeoDataFrame(geometry=gdf.buffer(buffer_radius), crs=crs_utm)
    return gpd.GeoDataFrame(geometry=gdf_buffer.envelope, crs=crs_utm)


def generate_candidates(search_area, people_points):
    """Генерация сетки точек-кандидатов в пределах полигона."""
    minx, miny, maxx, maxy = search_area.iloc[0].geometry.bounds
    width = maxx - minx
    height = maxy - miny
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


# ===========================================================
#     ЗАМЕНА ORS build_matrix НА 2GIS ВЕРСИЮ
# ===========================================================
def build_matrix_2gis(client: DistanceMatrixCalculator, sources, targets, profiles):
    """Аналог ORS build_matrix(), но через API 2GIS."""
    profile_groups = defaultdict(list)
    for i, p in enumerate(profiles):
        profile_groups[p].append(i)

    num_people = len(sources)
    num_targets = len(targets)
    durations = np.full((num_people, num_targets), np.inf, dtype=float)

    for profile, idxs in profile_groups.items():
        print(f"▶ Обработка профиля '{profile}' ({len(idxs)} источников)")

        group_sources = [sources[i] for i in idxs]
        start_points = [{"lat": p.y, "lon": p.x} for p in group_sources]
        target_points = [{"lat": p.y, "lon": p.x} for p in targets]

        result = client.calculate_matrix(start_points, target_points)
        routes = result.get("routes", [])

        for route in routes:
            s = route["source_id"]
            t = route["target_id"]
            if route.get("status") == "OK" and s < len(idxs) and t < num_targets:
                durations[idxs[s], t] = route["duration"]

    return durations


def build_main_vector_2gis(client: DistanceMatrixCalculator, candidates, dest, profile):
    """Матрица времени от кандидатов до одной точки."""
    start_points = [{"lat": p.y, "lon": p.x} for p in candidates]
    target_points = [{"lat": dest.y, "lon": dest.x}]
    result = client.calculate_matrix(start_points, target_points)
    routes = result.get("routes", [])
    durations = np.full(len(candidates), np.inf, dtype=float)
    for r in routes:
        if r.get("status") == "OK":
            durations[r["source_id"]] = r["duration"]
    return durations


# ===========================================================
#     ОПТИМИЗАЦИЯ МЕСТА ВСТРЕЧИ
# ===========================================================
def find_optimal_meetpoint(
    matrix_people_to_meetpoint, vector_meetpoint_to_dest, candidates, type_of_meetpoint
):
    """Находит оптимальную точку встречи."""
    people_count = matrix_people_to_meetpoint.shape[0]
    if vector_meetpoint_to_dest is None:
        if type_of_meetpoint == "minisum":
            j_sum = np.argmin(np.sum(matrix_people_to_meetpoint, axis=0))
            return candidates[j_sum]
        elif type_of_meetpoint == "minimax":
            j_max = np.argmin(np.max(matrix_people_to_meetpoint, axis=0))
            return candidates[j_max]
        else:
            raise ValueError("type_of_meetpoint должен быть 'minisum' или 'minimax'")
    else:
        if type_of_meetpoint == "minisum":
            sum_persons = np.sum(matrix_people_to_meetpoint, axis=0)
            sum_obj = sum_persons + people_count * vector_meetpoint_to_dest
            j_sum = np.argmin(sum_obj)
            return candidates[j_sum]
        elif type_of_meetpoint == "minimax":
            max_arr = np.max(matrix_people_to_meetpoint, axis=0)
            max_obj = max_arr + vector_meetpoint_to_dest
            j_max = np.argmin(max_obj)
            return candidates[j_max]
        else:
            raise ValueError("type_of_meetpoint должен быть 'minisum' или 'minimax'")


# ===========================================================
#     ОСНОВНОЙ СЦЕНАРИЙ
# ===========================================================
if __name__ == "__main__":
    type_of_meetpoint = "minimax"
    dest_point = Point(38.765574, 55.095276)
    dest_profile = "car"

    people_points = [
        Point(37.802357, 55.668757),
        Point(37.527237, 55.644621),
        Point(37.531429, 55.790507),
        Point(37.700379, 55.903512),
    ]
    people_profiles = ["car", "car", "car", "car"]

    client_2gis = DistanceMatrixCalculator(GIS2_API_KEY)

    base_search_area = create_base_search_area(people_points)
    pre_candidates, (x_step, y_step) = generate_candidates(
        base_search_area, people_points
    )

    matrix_people_to_pre_meetpoint = build_matrix_2gis(
        client_2gis, people_points, pre_candidates, people_profiles
    )
    vector_pre_meetpoint_to_dest = (
        build_main_vector_2gis(client_2gis, pre_candidates, dest_point, dest_profile)
        if dest_point is not None
        else None
    )

    best_pre_meetpoint = find_optimal_meetpoint(
        matrix_people_to_pre_meetpoint,
        vector_pre_meetpoint_to_dest,
        pre_candidates,
        type_of_meetpoint,
    )

    local_search_area = create_local_search_area(best_pre_meetpoint, x_step, y_step)
    candidates, _ = generate_candidates(local_search_area, people_points)
    matrix_people_to_meetpoint = build_matrix_2gis(
        client_2gis, people_points, candidates, people_profiles
    )
    vector_meetpoint_to_dest = (
        build_main_vector_2gis(client_2gis, candidates, dest_point, dest_profile)
        if dest_point is not None
        else None
    )

    best_meetpoint = find_optimal_meetpoint(
        matrix_people_to_meetpoint,
        vector_meetpoint_to_dest,
        candidates,
        type_of_meetpoint,
    )

    best_meetpoint_coords = (best_meetpoint.x, best_meetpoint.y)
    best_meetpoint = find_transport_stop_near_meetpoint(
        best_meetpoint_coords, GIS2_API_KEY, radius=1500
    )
