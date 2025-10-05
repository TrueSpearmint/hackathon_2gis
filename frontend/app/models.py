"""Data models for script ingestion and optimization requests."""
from __future__ import annotations

from typing import Any, Dict, List, Optional

from pydantic import BaseModel, Field, root_validator, validator


class Stop(BaseModel):
    """A geographic point that can be referenced by coordinates or address."""

    lat: Optional[float] = None
    lng: Optional[float] = None
    address: Optional[str] = None

    @root_validator(pre=True)
    def validate_location(cls, values: Dict[str, Any]) -> Dict[str, Any]:
        if not values:
            raise ValueError("stop cannot be empty")
        lat_present = values.get("lat") is not None
        lng_present = values.get("lng") is not None
        address_present = bool(values.get("address"))
        if not address_present and not (lat_present and lng_present):
            raise ValueError("stop must include either address or both lat/lng")
        return values

    def to_coordinates(self) -> Dict[str, float]:
        """Return {lat, lng} if both are present."""
        if self.lat is None or self.lng is None:
            raise ValueError("coordinates unavailable; resolve address first")
        return {"lat": self.lat, "lng": self.lng}


class UserStop(BaseModel):
    """A user with a starting point and optional preferences."""

    user_id: str
    start: Stop
    prefs: Dict[str, Any] = Field(default_factory=dict)

    @validator("user_id")
    def validate_user_id(cls, value: str) -> str:
        if not value:
            raise ValueError("user_id is required")
        return value


class Script(BaseModel):
    """Input script describing users and a shared destination."""

    script_id: Optional[str] = None
    users: List[UserStop]
    destination: Stop
    meta: Dict[str, Any] = Field(default_factory=dict)

    @validator("users")
    def validate_users(cls, value: List[UserStop]) -> List[UserStop]:
        if not value:
            raise ValueError("script must include at least one user")
        return value


class OptimizeRequest(BaseModel):
    """API payload requesting an optimization run."""

    script_id: str
    algorithm: str = Field(default="greedy")

    @validator("algorithm")
    def validate_algorithm(cls, value: str) -> str:
        supported = {"greedy", "ortools", "custom"}
        if value not in supported:
            raise ValueError(f"algorithm must be one of {supported}")
        return value


class TaskStatus(BaseModel):
    """Represents the state of a background task."""

    task_id: str
    status: str
    script_id: Optional[str] = None
    error: Optional[str] = None
    result: Optional[Dict[str, Any]] = None


# TODO: Extend models with richer validations (e.g., bounding boxes, vehicle constraints).
