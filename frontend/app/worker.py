"""In-memory background worker stub for running optimizations safely."""
from __future__ import annotations

import threading
import uuid
from concurrent.futures import ThreadPoolExecutor
from typing import Dict, Optional

# NOTE: This stub intentionally avoids executing arbitrary user code. See comments below
# for hardening recommendations when untrusted scripts must be run.

from .gis_client import geocode, route
from .models import OptimizeRequest, Script, Stop, TaskStatus, UserStop
from .optimization import optimize_multi_user


class ScriptRepository:
    """Thread-safe storage for uploaded scripts."""

    def __init__(self) -> None:
        self._scripts: Dict[str, Script] = {}
        self._lock = threading.Lock()

    def save(self, script: Script) -> str:
        script_id = script.script_id or str(uuid.uuid4())
        script.script_id = script_id
        with self._lock:
            self._scripts[script_id] = script
        return script_id

    def get(self, script_id: str) -> Optional[Script]:
        with self._lock:
            return self._scripts.get(script_id)


class TaskManager:
    """Minimal background worker that simulates asynchronous optimization."""

    def __init__(self) -> None:
        self._statuses: Dict[str, TaskStatus] = {}
        self._routes: Dict[str, Dict[str, object]] = {}
        self._lock = threading.Lock()
        self._executor = ThreadPoolExecutor(max_workers=4)

    def enqueue(self, request: OptimizeRequest) -> str:
        task_id = str(uuid.uuid4())
        status = TaskStatus(task_id=task_id, status="pending", script_id=request.script_id)
        with self._lock:
            self._statuses[task_id] = status
        self._executor.submit(self._run_task, task_id, request)
        return task_id

    def _run_task(self, task_id: str, request: OptimizeRequest) -> None:
        self._set_status(task_id, "running")
        script = script_store.get(request.script_id)
        if not script:
            self._set_status(task_id, "error", error="script not found")
            return
        try:
            normalized_script = _ensure_coordinates(script)
            plan = optimize_multi_user(normalized_script.users, normalized_script.destination, request.algorithm)
            feature_collection = _build_feature_collection(plan)
            with self._lock:
                self._routes[normalized_script.script_id] = feature_collection
            self._set_status(task_id, "done", result={"visit_order": plan.get("visit_order")})
        except Exception as exc:  # pylint: disable=broad-except
            # In production this should be narrowed down and logged.
            self._set_status(task_id, "error", error=str(exc))

    def get_status(self, task_id: str) -> Optional[TaskStatus]:
        with self._lock:
            return self._statuses.get(task_id)

    def get_route(self, script_id: str) -> Optional[Dict[str, object]]:
        with self._lock:
            return self._routes.get(script_id)

    def _set_status(self, task_id: str, status_value: str, *, error: Optional[str] = None, result: Optional[Dict[str, object]] = None) -> None:
        with self._lock:
            status = self._statuses.get(task_id)
            if not status:
                status = TaskStatus(task_id=task_id, status=status_value)
            status.status = status_value
            status.error = error
            status.result = result
            self._statuses[task_id] = status


script_store = ScriptRepository()
task_manager = TaskManager()


def _ensure_coordinates(script: Script) -> Script:
    """Populate missing coordinates using geocode fallbacks."""
    for user in script.users:
        _materialize_stop(user.start)
    _materialize_stop(script.destination)
    return script


def _materialize_stop(stop: Stop) -> None:
    if stop.lat is not None and stop.lng is not None:
        return
    if not stop.address:
        raise ValueError("cannot determine coordinates without address")
    coords = geocode(stop.address)
    stop.lat = coords.get("lat")
    stop.lng = coords.get("lng")


def _build_feature_collection(plan: Dict[str, object]) -> Dict[str, object]:
    features = []
    for route_plan in plan.get("routes", []):
        sequence = route_plan.get("sequence", [])
        feature = route(sequence)
        feature.setdefault("properties", {}).update(
            {
                "user_id": route_plan.get("user_id"),
                "estimated_distance_km": route_plan.get("estimated_distance_km"),
            }
        )
        features.append(feature)

    if plan.get("visit_order"):
        order_feature = {
            "type": "Feature",
            "geometry": {"type": "MultiPoint", "coordinates": []},
            "properties": {
                "provider": "meta",
                "visit_order": plan["visit_order"],
            },
        }
        features.append(order_feature)

    return {"type": "FeatureCollection", "features": features}


# Security guidance for executing untrusted scripts:
# - Prefer container isolation (Docker, gVisor, Firecracker microVMs) per task.
# - Run containers with dedicated users, read-only file systems, ulimits, seccomp profiles.
# - Enforce CPU/memory/time quotas (cgroups, --memory, --cpus) and network lockdown.
# - Optionally use Firejail or systemd-nspawn for lightweight isolation.
# - NEVER mount secrets (API keys, DB creds) inside untrusted sandboxes.
# - Audit inputs/outputs to prevent data exfiltration.
#
# Example pattern for containerized execution (commented on purpose):
# import subprocess
# subprocess.run([
#     "docker", "run", "--rm", "--network", "none", "--memory", "256m",
#     "--cpus", "1", "my-sandbox-image", "python", "worker.py"
# ], check=False, timeout=60)
# TODO: Replace stub worker with hardened job runner once sandbox strategy is finalized.
