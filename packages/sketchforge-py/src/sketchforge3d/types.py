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
from typing import Any, Dict, List, Mapping, Optional, Sequence, Tuple

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

#: The directions a shell request can name a face by, in the shape's own frame:
#: centred in X and Z with its base at the bottom, ``front`` towards the viewer.
FACE_DIRECTIONS: Tuple[str, ...] = ("top", "bottom", "left", "right", "front", "back")

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


#: How far round a sweep goes and how fast it rises, as the server reports it.
RevolveSummary = Mapping[str, float]

#: The per-kind parameters the server both accepts and reports back. Which of
#: them a shape carries depends on its kind, so they live in ``parameters``
#: rather than as fields that would be ``None`` on almost every shape.
SHAPE_PARAMETER_NAMES: Tuple[str, ...] = (
    "steps",
    "sides",
    "bevel",
    "segments",
    "topRadius",
    "baseRadius",
    "taperTopWidth",
    "taperTopDepth",
    "taperBottomWidth",
    "taperBottomDepth",
    "teeth",
    "toothSize",
    "toothWidth",
    "centerHoleSize",
    "gearType",
    "helixAngle",
    "loftBottomShape",
    "loftTopShape",
    "loftTopWidth",
    "loftTopDepth",
    "loftBottomRotation",
    "loftTopRotation",
    "loftSegments",
    "loftLayers",
    "text",
    "font",
)

#: Summary fields that describe a shape rather than set anything on it. The
#: server accepts and ignores them, so a summary can be sent straight back.
SHAPE_DESCRIPTION_FIELDS: Tuple[str, ...] = (
    "id",
    "kind",
    "requestKind",
    "sketchOperation",
    "groupedCount",
)


@dataclass(frozen=True)
class ShapeSummary:
    """
    A shape as the server reports it.

    ``kind`` is the stored kind rather than the requested one: a ``cube`` comes
    back a ``box``, and a ``revolve`` or ``thread`` comes back a ``mesh``,
    because that is what the project holds. ``request_kind`` is the other half
    of that -- the kind a ``POST`` would need to build the shape again, which is
    what tells a thread apart from an imported STL when both store as ``mesh``.
    It is ``None`` for a shape no request reproduces, such as a boolean cut.

    Every per-kind parameter the server accepts also comes back, under
    ``parameters``, so a read, a change and a write lose nothing.
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
    request_kind: Optional[str] = None
    sketch_operation: Optional[str] = None
    #: The per-kind parameters this shape carries, under the server's own names.
    parameters: Dict[str, Any] = field(default_factory=dict)
    #: Present on a revolve or a thread: the sweep that built it.
    revolve: Optional[Dict[str, Any]] = None
    #: The outline the sweep ran round, when it was described rather than drawn.
    profile: Optional[List[List[float]]] = None
    extra: Dict[str, Any] = field(default_factory=dict)

    _KNOWN = (
        "id",
        "name",
        "kind",
        "requestKind",
        "sketchOperation",
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
        "revolve",
        "profile",
    ) + SHAPE_PARAMETER_NAMES

    @classmethod
    def from_payload(cls, payload: Mapping[str, Any]) -> "ShapeSummary":
        revolve = payload.get("revolve")
        profile = payload.get("profile")
        return cls(
            id=_text(payload, "id"),
            name=_text(payload, "name"),
            kind=_text(payload, "kind"),
            request_kind=payload.get("requestKind") if isinstance(payload.get("requestKind"), str) else None,
            sketch_operation=payload.get("sketchOperation") if isinstance(payload.get("sketchOperation"), str) else None,
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
            parameters={name: payload[name] for name in SHAPE_PARAMETER_NAMES if name in payload},
            revolve=dict(revolve) if isinstance(revolve, Mapping) else None,
            profile=[[float(value) for value in point] for point in profile] if isinstance(profile, list) else None,
            extra={key: value for key, value in payload.items() if key not in cls._KNOWN},
        )

    @property
    def sides(self) -> Any:
        return self.parameters.get("sides")

    @property
    def pitch(self) -> Optional[float]:
        """A thread's axial rise per turn, or ``None`` when this is not a sweep."""
        return None if self.revolve is None else float(self.revolve.get("pitch", 0.0))

    @property
    def grouped_count(self) -> int:
        value = self.extra.get("groupedCount")
        return int(value) if isinstance(value, (int, float)) else 0

    def as_patch(self, **changes: Any) -> Dict[str, Any]:
        """
        This shape as the change that would reproduce it, with overrides applied.

        The round trip the API promises, written once: read a shape, call this
        with the one field in question, and send the result.
        """
        patch: Dict[str, Any] = {
            "name": self.name,
            "color": self.color,
            "hole": self.hole,
            "locked": self.locked,
            "hidden": self.hidden,
            "x": self.x,
            "z": self.z,
            "elevation": self.elevation,
            "width": self.width,
            "depth": self.depth,
            "height": self.height,
            "rotation": self.rotation,
            "rotationX": self.rotation_x,
            "rotationZ": self.rotation_z,
            **self.parameters,
        }
        if self.revolve is not None:
            patch["revolve"] = dict(self.revolve)
        if self.profile is not None:
            patch["profile"] = [list(point) for point in self.profile]
        patch.update(changes)
        return patch


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
class Vector3:
    x: float
    y: float
    z: float


@dataclass(frozen=True)
class FaceSummary:
    index: int
    #: As OCCT names the surface: ``plane``, ``cylinder``, ``bspline``...
    surface_type: str
    area: float
    #: Area-weighted centre, a real point on the face even when it is curved.
    centroid: Vector3
    #: The outward normal, or None for a surface that cannot report one.
    normal: Optional[Vector3]
    #: The direction name a shell request can open this face by.
    #:
    #: Only the outermost flat face pointing a given way takes the name: the
    #: floor of a hollow part's cavity points up as surely as its lid does, and
    #: opening the wrong one of those looks like nothing happened.
    facing: Optional[str]

    @classmethod
    def from_payload(cls, payload: Mapping[str, Any]) -> "FaceSummary":
        centroid = payload.get("centroid") or {}
        normal = payload.get("normal")
        facing = payload.get("facing")
        return cls(
            index=int(_number(payload, "index")),
            surface_type=_text(payload, "surfaceType", "unknown"),
            area=_number(payload, "area"),
            centroid=Vector3(
                x=_number(centroid, "x"),
                y=_number(centroid, "y"),
                z=_number(centroid, "z"),
            ),
            normal=(
                Vector3(x=_number(normal, "x"), y=_number(normal, "y"), z=_number(normal, "z"))
                if isinstance(normal, Mapping)
                else None
            ),
            facing=str(facing) if isinstance(facing, str) else None,
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


#: Hollowing answers with the same three fields a treatment does.
ShellResult = TreatmentResult
