"""
The wire shapes of ``/api/v1``.

Requests are mappings, because the server takes a bag of parameters and ignores
what it does not know; responses are dataclasses, because a macro reads them by
name and a typo in ``shape.widht`` should be an error rather than a ``None``.

Fields unknown to this version are kept in ``extra`` rather than dropped, so a
client built against an older server still round-trips what a newer one sends.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, List, Mapping, Sequence, Tuple

PARAMETRIC_SHAPE_KINDS: Tuple[str, ...] = (
    "box",
    "cube",
    "cylinder",
    "cone",
    "sphere",
    "halfSphere",
    "torus",
    "tube",
    "ring",
    "polygon",
    "pyramid",
    "roof",
    "roundRoof",
    "wedge",
    "icosahedron",
    "text",
    "loft",
    "gear",
)

SHAPE_KINDS: Tuple[str, ...] = PARAMETRIC_SHAPE_KINDS + ("revolve", "thread")

THREAD_DESIGNATIONS: Tuple[str, ...] = (
    "M2",
    "M2.5",
    "M3",
    "M4",
    "M5",
    "M6",
    "M8",
    "M10",
    "M12",
    "M16",
    "M20",
    "#4-40",
    "#6-32",
    "#8-32",
    "#10-24",
    "1/4-20",
    "5/16-18",
    "3/8-16",
    "1/2-13",
)

#: Dimensions outside this range are clamped by the server rather than refused.
MIN_DIMENSION = 0.01
MAX_DIMENSION = 10_000

#: One POST may carry at most this many shapes.
MAX_SHAPES_PER_REQUEST = 200

#: A shape as it is asked for: ``{"kind": "cylinder", "width": 8, "sides": 6}``.
ShapeRequest = Mapping[str, Any]

#: The fields a PATCH may change. Anything else needs a new shape.
ShapePatch = Mapping[str, Any]

#: ``[distance from the axis, position along it]``.
ProfilePoint = Sequence[float]


def _number(payload: Mapping[str, Any], key: str, default: float = 0.0) -> float:
    value = payload.get(key, default)
    return float(value) if isinstance(value, (int, float)) else default


def _text(payload: Mapping[str, Any], key: str, default: str = "") -> str:
    value = payload.get(key, default)
    return value if isinstance(value, str) else default


@dataclass(frozen=True)
class ShapeSummary:
    """
    A shape as the server reports it.

    ``kind`` is the stored kind rather than the requested one: a ``cube`` comes
    back a ``box``, and a ``revolve`` or ``thread`` comes back a ``mesh``,
    because that is what the project holds.
    """

    id: str
    name: str
    kind: str
    color: str
    hole: bool
    locked: bool
    hidden: bool
    x: float
    z: float
    elevation: float
    width: float
    depth: float
    height: float
    rotation: float
    rotation_x: float
    rotation_z: float
    extra: Dict[str, Any] = field(default_factory=dict)

    _KNOWN = (
        "id",
        "name",
        "kind",
        "color",
        "hole",
        "locked",
        "hidden",
        "x",
        "z",
        "elevation",
        "width",
        "depth",
        "height",
        "rotation",
        "rotationX",
        "rotationZ",
    )

    @classmethod
    def from_payload(cls, payload: Mapping[str, Any]) -> "ShapeSummary":
        return cls(
            id=_text(payload, "id"),
            name=_text(payload, "name"),
            kind=_text(payload, "kind"),
            color=_text(payload, "color"),
            hole=bool(payload.get("hole")),
            locked=bool(payload.get("locked")),
            hidden=bool(payload.get("hidden")),
            x=_number(payload, "x"),
            z=_number(payload, "z"),
            elevation=_number(payload, "elevation"),
            width=_number(payload, "width"),
            depth=_number(payload, "depth"),
            height=_number(payload, "height"),
            rotation=_number(payload, "rotation"),
            rotation_x=_number(payload, "rotationX"),
            rotation_z=_number(payload, "rotationZ"),
            extra={key: value for key, value in payload.items() if key not in cls._KNOWN},
        )

    @property
    def sides(self) -> Any:
        return self.extra.get("sides")

    @property
    def grouped_count(self) -> int:
        value = self.extra.get("groupedCount")
        return int(value) if isinstance(value, (int, float)) else 0


@dataclass(frozen=True)
class ProjectSummary:
    id: str
    name: str
    #: How many shapes the project holds.
    shapes: int
    revision: int
    updated_at: int
    package_bytes: int

    @classmethod
    def from_payload(cls, payload: Mapping[str, Any]) -> "ProjectSummary":
        return cls(
            id=_text(payload, "id"),
            name=_text(payload, "name"),
            shapes=int(_number(payload, "shapes")),
            revision=int(_number(payload, "revision")),
            updated_at=int(_number(payload, "updatedAt")),
            package_bytes=int(_number(payload, "packageBytes")),
        )


@dataclass(frozen=True)
class ProjectDetail:
    id: str
    name: str
    created_at: int
    snap_grid: Dict[str, Any]
    workspace: Dict[str, Any]
    shapes: List[ShapeSummary]

    @classmethod
    def from_payload(cls, payload: Mapping[str, Any]) -> "ProjectDetail":
        shapes = payload.get("shapes") or []
        return cls(
            id=_text(payload, "id"),
            name=_text(payload, "name"),
            created_at=int(_number(payload, "createdAt")),
            snap_grid=dict(payload.get("snapGrid") or {}),
            workspace=dict(payload.get("workspace") or {}),
            shapes=[ShapeSummary.from_payload(entry) for entry in shapes],
        )


@dataclass(frozen=True)
class EdgeMidpoint:
    x: float
    y: float
    z: float


@dataclass(frozen=True)
class EdgeSummary:
    index: int
    length: float
    #: As OCCT names it: ``line``, ``circle``, ``bspline``, or ``unknown``.
    curve_type: str
    midpoint: EdgeMidpoint
    #: A seam, where one curved surface meets itself, has no two faces to blend
    #: and cannot be treated; naming one explicitly is an error, not a skip.
    filletable: bool

    @classmethod
    def from_payload(cls, payload: Mapping[str, Any]) -> "EdgeSummary":
        midpoint = payload.get("midpoint") or {}
        return cls(
            index=int(_number(payload, "index")),
            length=_number(payload, "length"),
            curve_type=_text(payload, "curveType", "unknown"),
            midpoint=EdgeMidpoint(
                x=_number(midpoint, "x"),
                y=_number(midpoint, "y"),
                z=_number(midpoint, "z"),
            ),
            filletable=bool(payload.get("filletable")),
        )


@dataclass(frozen=True)
class ShapeWriteResult:
    shapes: List[ShapeSummary]
    revision: int


@dataclass(frozen=True)
class TreatmentResult:
    shape: ShapeSummary
    triangles: int
    revision: int
