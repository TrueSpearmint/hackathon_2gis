from math import atan2, cos, radians, sin, sqrt

import requests


def calculate_distance(point1, point2):
    """Вычисляет расстояние между двумя точками (lon, lat) в метрах (Haversine formula)."""
    R = 6371000  # радиус Земли в метрах
    lon1, lat1 = radians(point1[0]), radians(point1[1])
    lon2, lat2 = radians(point2[0]), radians(point2[1])

    dlon = lon2 - lon1
    dlat = lat2 - lat1

    a = sin(dlat / 2) ** 2 + cos(lat1) * cos(lat2) * sin(dlon / 2) ** 2
    c = 2 * atan2(sqrt(a), sqrt(1 - a))

    return R * c


def find_metro_stations_2gis(center_point, api_key, radius=1500):
    """Поиск станций метро через 2GIS API."""
    url = "https://catalog.api.2gis.com/3.0/items"

    params = {
        "key": api_key,
        "q": "станция метро",
        "location": f"{center_point[0]},{center_point[1]}",
        "radius": radius,
        "page_size": 10,
        "fields": "items.point,items.type,items.name",
        "sort": "distance",
        "search_type": "discovery",
    }

    try:
        response = requests.get(url, params=params, timeout=10)
        data = response.json()

        items = []
        if "result" in data and "items" in data["result"]:
            items = data["result"]["items"]

        metro_stations = []
        for item in items:
            point_data = item.get("point", {})
            if point_data and "lon" in point_data and "lat" in point_data:
                item_point = (point_data["lon"], point_data["lat"])
                distance = calculate_distance(center_point, item_point)

                item_type = item.get("type", "")
                item_name = item.get("name", "").lower()

                is_metro_station = (
                    "станция" in item_name and "метро" in item_name
                ) or item_type in ["station", "station.metro", "station_entrance"]
                is_real_object = not any(
                    exclude in item_name
                    for exclude in ["компания", "фирма", "агентство", "тур"]
                )

                if is_metro_station and is_real_object and distance <= radius:
                    item["distance"] = distance
                    metro_stations.append(item)

        metro_stations.sort(key=lambda x: x.get("distance", float("inf")))
        return metro_stations

    except Exception:
        return []


def find_bus_stops_overpass(center_point, radius=1500):
    """Поиск автобусных остановок через Overpass API."""
    overpass_url = "http://overpass-api.de/api/interpreter"

    lat, lon = center_point[1], center_point[0]

    query = f"""
    [out:json][timeout:25];
    (
      node["highway"="bus_stop"](around:{radius},{lat},{lon});
      node["public_transport"="stop_position"]["bus"="yes"](around:{radius},{lat},{lon});
    );
    out body;
    """

    try:
        response = requests.post(overpass_url, data=query, timeout=15)
        data = response.json()

        stops = []
        for element in data.get("elements", []):
            if "lat" in element and "lon" in element:
                stop_point = (element["lon"], element["lat"])
                distance = calculate_distance(center_point, stop_point)
                stop_name = element.get("tags", {}).get("name", "Остановка")

                stops.append(
                    {
                        "name": stop_name,
                        "type": "bus_stop",
                        "point": {"lon": element["lon"], "lat": element["lat"]},
                        "distance": distance,
                    }
                )

        stops.sort(key=lambda x: x.get("distance", float("inf")))
        return stops

    except Exception:
        return []


def find_transport_stop_near_meetpoint(center_point, api_key, radius=1500):
    """
    Находит точку встречи (meeting point) в радиусе от заданной точки.
    Возвращает координаты (lon, lat).
    """
    metro_stations = find_metro_stations_2gis(center_point, api_key, radius)
    if metro_stations:
        point_data = metro_stations[0].get("point", {})
        return (point_data["lon"], point_data["lat"])

    bus_stops = find_bus_stops_overpass(center_point, radius)
    if bus_stops:
        point_data = bus_stops[0].get("point", {})
        return (point_data["lon"], point_data["lat"])

    return (center_point[0] + 0.001, center_point[1] + 0.001)
