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
from typing import Any, Dict, Generic, List, Literal, Mapping, Optional, Sequence, Tuple, TypedDict, TypeVar, Union, cast, get_args

TPageItem = TypeVar("TPageItem")

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

SHAPE_KINDS: Tuple[str, ...] = PARAMETRIC_SHAPE_KINDS + ("revolve", "thread", "sketchSweep")

# Kinds accepted by the shape creation endpoint. Callers get useful editor
# completion from the Literal; the runtime tuple is derived from it. Neither
# changes the permissive mapping contract of ShapeRequest below.
RequestableShapeKind = Literal[
    "box", "cube", "cylinder", "cone", "sphere", "halfSphere", "torus", "tube",
    "ring", "polygon", "pyramid", "roof", "roundRoof", "wedge", "icosahedron",
    "text", "loft", "gear", "revolve", "thread", "sketchSweep",
]
REQUESTABLE_SHAPE_KINDS: Tuple[RequestableShapeKind, ...] = get_args(RequestableShapeKind)


class _ShapePlacement(TypedDict, total=False):
    name: str
    color: str
    x: float
    z: float
    elevation: float
    width: float
    depth: float
    height: float
    size: float
    rotation: float
    rotationX: float
    rotationZ: float
    hole: bool
    taperTopWidth: float
    taperTopDepth: float
    taperBottomWidth: float
    taperBottomDepth: float


class BoxShapeRequest(_ShapePlacement):
    kind: Literal["box"]


class CubeShapeRequest(_ShapePlacement):
    kind: Literal["cube"]


class _CylinderShapeRequestBase(_ShapePlacement):
    kind: Literal["cylinder"]


class CylinderShapeRequest(_CylinderShapeRequestBase, total=False):
    sides: int


class _ConeShapeRequestBase(_ShapePlacement):
    kind: Literal["cone"]


class ConeShapeRequest(_ConeShapeRequestBase, total=False):
    sides: int
    topRadius: float
    baseRadius: float


class _SphereShapeRequestBase(_ShapePlacement):
    kind: Literal["sphere"]


class SphereShapeRequest(_SphereShapeRequestBase, total=False):
    steps: int


class _HalfSphereShapeRequestBase(_ShapePlacement):
    kind: Literal["halfSphere"]


class HalfSphereShapeRequest(_HalfSphereShapeRequestBase, total=False):
    steps: int


class TorusShapeRequest(_ShapePlacement):
    kind: Literal["torus"]


class _TubeShapeRequestBase(_ShapePlacement):
    kind: Literal["tube"]


class TubeShapeRequest(_TubeShapeRequestBase, total=False):
    bevel: float


class _RingShapeRequestBase(_ShapePlacement):
    kind: Literal["ring"]


class RingShapeRequest(_RingShapeRequestBase, total=False):
    bevel: float


class PolygonShapeRequest(_ShapePlacement):
    kind: Literal["polygon"]


class _PyramidShapeRequestBase(_ShapePlacement):
    kind: Literal["pyramid"]


class PyramidShapeRequest(_PyramidShapeRequestBase, total=False):
    sides: int


class RoofShapeRequest(_ShapePlacement):
    kind: Literal["roof"]


class _RoundRoofShapeRequestBase(_ShapePlacement):
    kind: Literal["roundRoof"]


class RoundRoofShapeRequest(_RoundRoofShapeRequestBase, total=False):
    sides: int


class WedgeShapeRequest(_ShapePlacement):
    kind: Literal["wedge"]


class IcosahedronShapeRequest(_ShapePlacement):
    kind: Literal["icosahedron"]


class _TextShapeRequestBase(_ShapePlacement):
    kind: Literal["text"]


class TextShapeRequest(_TextShapeRequestBase, total=False):
    text: str
    font: str
    bevel: float
    segments: int


class _LoftShapeRequestBase(_ShapePlacement):
    kind: Literal["loft"]


class LoftShapeRequest(_LoftShapeRequestBase, total=False):
    loftBottomShape: str
    loftTopShape: str
    loftTopWidth: float
    loftTopDepth: float
    loftBottomRotation: float
    loftTopRotation: float
    loftSegments: int
    loftLayers: int


class _GearShapeRequestBase(_ShapePlacement):
    kind: Literal["gear"]


class GearShapeRequest(_GearShapeRequestBase, total=False):
    teeth: int
    toothSize: float
    toothWidth: float
    centerHoleSize: float
    gearType: str
    helixAngle: float


class _RevolveShapeRequestBase(_ShapePlacement):
    kind: Literal["revolve"]
    profile: Sequence[Sequence[float]]


class RevolveShapeRequest(_RevolveShapeRequestBase, total=False):
    pitch: float
    turns: float
    startAngle: float
    sweepAngle: float
    sides: int
    quality: int
    coreRadius: float
    outline: Sequence[Sequence[float]]
    revolve: Mapping[str, Any]


class _ThreadShapeRequestBase(_ShapePlacement):
    kind: Literal["thread"]


class ThreadShapeRequest(_ThreadShapeRequestBase, total=False):
    size: str  # type: ignore[misc]  # Thread designation replaces numeric placement size.
    diameter: float
    length: float
    pitch: float
    turns: float
    clearance: float
    core: bool
    sides: int
    quality: int
    profile: Sequence[Sequence[float]]
    outline: Sequence[Sequence[float]]
    revolve: Mapping[str, Any]


class SketchSweepPoint(TypedDict, total=False):
    id: str
    x: float
    z: float
    sweepDepth: float
    sweepRole: Literal["section", "spine"]
    handleIn: Mapping[str, float]
    handleOut: Mapping[str, float]
    mode: Literal["corner", "smooth", "split"]


class SketchSweepSegment(TypedDict, total=False):
    id: str
    startId: str
    endId: str
    kind: Literal["line", "bezier", "smooth"]


class SketchFixedConstraint(TypedDict):
    id: str
    kind: Literal["fixed"]
    pointId: str
    xMm: float
    zMm: float


class SketchCoincidentConstraint(TypedDict):
    id: str
    kind: Literal["coincident"]
    pointIds: Tuple[str, str]


class SketchAxisConstraint(TypedDict):
    id: str
    kind: Literal["horizontal", "vertical"]
    segmentId: str


class SketchSegmentPairConstraint(TypedDict):
    id: str
    kind: Literal["parallel", "perpendicular", "tangent", "equalLength"]
    segmentIds: Tuple[str, str]


class SketchDistanceConstraint(TypedDict):
    id: str
    kind: Literal["distance"]
    pointIds: Tuple[str, str]
    valueMm: float


SketchConstraint = Union[
    SketchFixedConstraint,
    SketchCoincidentConstraint,
    SketchAxisConstraint,
    SketchSegmentPairConstraint,
    SketchDistanceConstraint,
]


class SketchSweepProfile(TypedDict, total=False):
    points: Sequence[SketchSweepPoint]
    segments: Sequence[SketchSweepSegment]
    constraints: Sequence[SketchConstraint]
    sweepFrames: Mapping[str, Any]


class SketchSweepShapeRequest(_ShapePlacement):
    kind: Literal["sketchSweep"]
    profile: SketchSweepProfile


ShapeSpec = Union[
    BoxShapeRequest, CubeShapeRequest, CylinderShapeRequest, ConeShapeRequest,
    SphereShapeRequest, HalfSphereShapeRequest, TorusShapeRequest, TubeShapeRequest,
    RingShapeRequest, PolygonShapeRequest, PyramidShapeRequest, RoofShapeRequest,
    RoundRoofShapeRequest, WedgeShapeRequest, IcosahedronShapeRequest, TextShapeRequest,
    LoftShapeRequest, GearShapeRequest, RevolveShapeRequest, ThreadShapeRequest, SketchSweepShapeRequest,
]

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

#: The entities a measurement listing reports, one entry each.
MEASUREMENT_ENTITIES: Tuple[str, ...] = ("edge", "face")

#: What one end of a between-entities measurement may name. ``shape`` is the
#: whole solid, which is what "how far apart are these two parts" means; the
#: other two narrow it to one entity of that solid.
MEASUREMENT_END_ENTITIES: Tuple[str, ...] = ("edge", "face", "shape")

#: Why there is no radius, instead of a guessed number. The first three answer
#: for an edge and the last four for a face, which is why they are one set: a
#: caller reads them off ``radius_unavailable`` without having to know which
#: entity it was looking at.
MEASUREMENT_RADIUS_UNAVAILABLE_CODES: Tuple[str, ...] = (
    "notCircular",
    "ellipseHasNoSingleRadius",
    "degenerateCurve",
    "notCurved",
    "radiusVariesOverSurface",
    "radiusNotReportedByKernel",
    "degenerateSurface",
)

#: Why there is no angle. An angle is only defined between two flat faces.
MEASUREMENT_ANGLE_UNAVAILABLE_CODES: Tuple[str, ...] = ("notPlanar", "degenerateNormal")

#: Either reason, for a caller that only logs it. The server derives both from
#: one union of its own, but the two fields draw on disjoint halves of it -- a
#: radius is never missing because a face was not planar -- so each field
#: answers from its own set and this is the sum.
MEASUREMENT_UNAVAILABLE_CODES: Tuple[str, ...] = (
    MEASUREMENT_RADIUS_UNAVAILABLE_CODES + MEASUREMENT_ANGLE_UNAVAILABLE_CODES
)

#: A shape as it is asked for: ``{"kind": "cylinder", "width": 8, "sides": 6}``.
ShapeRequest = Mapping[str, Any]

#: One end of a between-entities measurement:
#: ``{"shapeId": "s1", "entity": "face", "index": 2}``. A missing ``entity``
#: means the whole shape, and takes no ``index``.
MeasurementEnd = Mapping[str, Any]

#: The fields a PATCH may change. Anything else needs a new shape.
ShapePatch = Mapping[str, Any]

ExportFormat = Literal["stl", "obj", "3mf", "step", "skf", "zip", "svg", "dxf"]

#: What an ``svg`` export shows: one of the kernel's named views, or the
#: four-view grid (front, top, right, iso), which is the default.
ExportView = Literal["multiview", "front", "back", "top", "bottom", "left", "right", "iso"]
EXPORT_VIEWS = ("multiview", "front", "back", "top", "bottom", "left", "right", "iso")

ExportSectionPlane = Literal["xy", "xz", "yz"]
EXPORT_SECTION_PLANES = ("xy", "xz", "yz")


class ExportSection(TypedDict):
    """An axis-aligned section in drawing coordinates; offset is in millimetres."""

    plane: ExportSectionPlane
    offset: float

#: ``[distance from the axis, position along it]``.
ProfilePoint = Sequence[float]


def _number(payload: Mapping[str, Any], key: str, default: float = 0.0) -> float:
    value = payload.get(key, default)
    return float(value) if isinstance(value, (int, float)) else default


def _text(payload: Mapping[str, Any], key: str, default: str = "") -> str:
    value = payload.get(key, default)
    return value if isinstance(value, str) else default


def _optional_number(payload: Mapping[str, Any], key: str) -> Optional[float]:
    """
    A number the server reports as ``null`` when it does not apply.

    Distinct from ``_number``, which defaults: a face has no length and a flat
    one has no radius, and ``0.0`` there would read as a measurement rather
    than as the absence of one.
    """
    value = payload.get(key)
    return float(value) if isinstance(value, (int, float)) and not isinstance(value, bool) else None


#: How far round a sweep goes and how fast it rises, as the server reports it.
#: Every value is a number except ``axis``, the ``{"x", "z"}`` workplane point
#: its axis of revolution stands at (see ``ShapeSummary.revolve_axis``).
RevolveSummary = Mapping[str, Union[float, Mapping[str, float]]]

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
    "stepAssembly",
    "stepComponent",
)


@dataclass(frozen=True)
class StepAssemblyNode:
    """A named STEP product and its nested component occurrences."""

    name: str
    children: List["StepAssemblyNode"] = field(default_factory=list)
    id: Optional[str] = None

    @classmethod
    def from_payload(cls, payload: Mapping[str, Any]) -> "StepAssemblyNode":
        return cls(
            name=str(payload.get("name", "")),
            children=[cls.from_payload(child) for child in payload.get("children", []) if isinstance(child, Mapping)],
            id=payload.get("id") if isinstance(payload.get("id"), str) else None,
        )


@dataclass(frozen=True)
class StepComponent:
    """STEP source occurrence identity and ancestry for an exploded solid."""

    id: str
    occurrence_id: str
    path: List[StepAssemblyNode]

    @classmethod
    def from_payload(cls, payload: Mapping[str, Any]) -> "StepComponent":
        return cls(
            id=str(payload.get("id", "")),
            occurrence_id=str(payload.get("occurrenceId", "")),
            path=[StepAssemblyNode.from_payload(node) for node in payload.get("path", []) if isinstance(node, Mapping)],
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
    sketch_source_id: Optional[str] = None
    sketch_profile: Optional[Dict[str, Any]] = None
    #: One editable face draft retained on a sketch extrusion.
    face_draft: Optional[Dict[str, Any]] = None
    #: The per-kind parameters this shape carries, under the server's own names.
    parameters: Dict[str, Any] = field(default_factory=dict)
    #: Present on a revolve or a thread: the sweep that built it.
    revolve: Optional[Dict[str, Any]] = None
    #: The outline the sweep ran round, when it was described rather than drawn.
    profile: Optional[List[List[float]]] = None
    #: The shape's face identities, in the order ``GET /faces`` lists them.
    face_ids: List[str] = field(default_factory=list)
    #: Face colors keyed by face id. A project saved before stable identity
    #: keys them by face index instead, and those keys are kept as they are
    #: rather than guessed at, because the server still accepts them.
    face_colors: Dict[str, str] = field(default_factory=dict)
    step_assembly: List[StepAssemblyNode] = field(default_factory=list)
    step_component: Optional[StepComponent] = None
    extra: Dict[str, Any] = field(default_factory=dict)

    _KNOWN = (
        "id",
        "name",
        "kind",
        "requestKind",
        "sketchOperation",
        "sketchSourceId",
        "sketchProfile",
        "faceDraft",
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
        "faceIds",
        "faceColors",
        "stepAssembly",
        "stepComponent",
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
            sketch_source_id=payload.get("sketchSourceId") if isinstance(payload.get("sketchSourceId"), str) else None,
            sketch_profile=dict(payload["sketchProfile"]) if isinstance(payload.get("sketchProfile"), Mapping) else None,
            face_draft=dict(payload["faceDraft"]) if isinstance(payload.get("faceDraft"), Mapping) else None,
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
            face_ids=[value for value in (payload.get("faceIds") or []) if isinstance(value, str)],
            face_colors={
                str(key): value
                for key, value in (payload.get("faceColors") or {}).items()
                if isinstance(value, str)
            },
            step_assembly=[StepAssemblyNode.from_payload(node) for node in payload.get("stepAssembly", []) if isinstance(node, Mapping)],
            step_component=StepComponent.from_payload(payload["stepComponent"]) if isinstance(payload.get("stepComponent"), Mapping) else None,
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
    def revolve_axis(self) -> Optional[Tuple[float, float]]:
        """
        Where a revolve's axis of revolution stands, as ``(x, z)``.

        A shape's ``x``/``z`` is the centre of its box, which for a partial
        sweep is off to one side of its axis. ``None`` when this is not a
        revolve, when it was saved before its axis was recorded (until it is
        next rebuilt), or when it is tilted so its axis is not vertical.
        """
        axis = None if self.revolve is None else self.revolve.get("axis")
        if not isinstance(axis, Mapping):
            return None
        x, z = axis.get("x"), axis.get("z")
        if isinstance(x, bool) or isinstance(z, bool) or not isinstance(x, (int, float)) or not isinstance(z, (int, float)):
            return None
        return (float(x), float(z))

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
        if self.sketch_profile is not None:
            patch["sketchProfile"] = self.sketch_profile
        if self.face_draft is not None:
            patch["faceDraft"] = dict(self.face_draft)
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
    #: The face's stable, project-persisted identity.
    #:
    #: This is what a face color is keyed by, and it survives an operation
    #: where ``index`` does not: OCCT reorders faces after a fillet, a chamfer
    #: or a mirror, so an index is only true until the next one. ``None`` from
    #: a server older than stable face identity.
    id: Optional[str]
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
        identity = payload.get("id")
        return cls(
            id=identity if isinstance(identity, str) and identity else None,
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
class MeasurementSummary:
    """
    One edge or face, measured from the exact B-rep rather than the mesh.

    ``index`` is the same index the edge and face listings give the entity, so
    a measurement and the fillet that follows it name the same thing. The
    fields that do not apply are ``None`` rather than zero: a face has no
    length, an edge has no area, and a straight line has no radius -- and a
    radius of ``0.0`` would read as a measurement rather than the absence of
    one.
    """

    entity: str
    index: int
    #: As OCCT names it: ``line``, ``circle``, ``ellipse``, ``bspline`` for an
    #: edge; ``plane``, ``cylinder``, ``sphere``, ``cone``, ``torus`` for a face.
    geometry_type: str
    #: Edge length in mm, arcs measured along the curve. None for a face.
    length: Optional[float]
    #: Face area in mm^2. None for an edge.
    area: Optional[float]
    radius: Optional[float]
    diameter: Optional[float]
    #: Degrees a circular edge runs through; a full circle is 360. None otherwise.
    sweep_degrees: Optional[float]
    #: Why there is no radius, from ``MEASUREMENT_RADIUS_UNAVAILABLE_CODES``.
    #: None when one is reported.
    radius_unavailable: Optional[str]

    @classmethod
    def from_payload(cls, payload: Mapping[str, Any]) -> "MeasurementSummary":
        unavailable = payload.get("radiusUnavailable")
        return cls(
            entity=_text(payload, "entity"),
            index=int(_number(payload, "index")),
            geometry_type=_text(payload, "geometryType", "unknown"),
            length=_optional_number(payload, "length"),
            area=_optional_number(payload, "area"),
            radius=_optional_number(payload, "radius"),
            diameter=_optional_number(payload, "diameter"),
            sweep_degrees=_optional_number(payload, "sweepDegrees"),
            radius_unavailable=unavailable if isinstance(unavailable, str) else None,
        )


@dataclass(frozen=True)
class MeasurementPair:
    #: Exact minimum distance between the two entities, in mm. Zero when they touch.
    distance: float
    #: Angle between two planar faces' outward normals, 0 to 180. None otherwise.
    angle_degrees: Optional[float]
    #: Why there is no angle, from ``MEASUREMENT_ANGLE_UNAVAILABLE_CODES``.
    #: None when one is reported.
    angle_unavailable: Optional[str]

    @classmethod
    def from_payload(cls, payload: Mapping[str, Any]) -> "MeasurementPair":
        unavailable = payload.get("angleUnavailable")
        return cls(
            distance=_number(payload, "distance"),
            angle_degrees=_optional_number(payload, "angleDegrees"),
            angle_unavailable=unavailable if isinstance(unavailable, str) else None,
        )


@dataclass(frozen=True)
class WallThicknessEstimate:
    """Sampled opposing-surface distance, not a certified minimum thickness."""

    minimum: Optional[float]
    unit: Literal["mm"]
    method: Literal["sampled-opposing-surface-distance"]
    samples_per_face: int
    faces_checked: int

    @classmethod
    def from_payload(cls, payload: Mapping[str, Any]) -> "WallThicknessEstimate":
        return cls(
            minimum=_optional_number(payload, "minimum"),
            unit="mm",
            method="sampled-opposing-surface-distance",
            samples_per_face=int(_number(payload, "samplesPerFace")),
            faces_checked=int(_number(payload, "facesChecked")),
        )


@dataclass(frozen=True)
class InterferencePair:
    a: Mapping[str, str]
    b: Mapping[str, str]
    gap: float
    overlap_volume: float
    precision: Literal["exact", "tessellated"]

    @classmethod
    def from_payload(cls, payload: Mapping[str, Any]) -> "InterferencePair":
        return cls(
            a={"id": _text(payload.get("a", {}), "id"), "name": _text(payload.get("a", {}), "name")},
            b={"id": _text(payload.get("b", {}), "id"), "name": _text(payload.get("b", {}), "name")},
            gap=_number(payload, "gap"),
            overlap_volume=_number(payload, "overlapVolume"),
            precision="tessellated" if _text(payload, "precision") == "tessellated" else "exact",
        )


@dataclass(frozen=True)
class InterferenceReport:
    shapes_checked: int
    candidate_pairs_checked: int
    clearance: float
    method: str
    pairs: List[InterferencePair]

    @classmethod
    def from_payload(cls, payload: Mapping[str, Any]) -> "InterferenceReport":
        return cls(
            shapes_checked=int(_number(payload, "shapesChecked")),
            candidate_pairs_checked=int(_number(payload, "candidatePairsChecked")),
            clearance=_number(payload, "clearance"),
            method=_text(payload, "method"),
            pairs=[InterferencePair.from_payload(pair) for pair in payload.get("pairs", []) if isinstance(pair, Mapping)],
        )


@dataclass(frozen=True)
class ShapeGeometryProvenance:
    source: Literal["parametric", "brep", "mesh"]
    precision: Literal["exact", "tessellated"]

    @classmethod
    def from_payload(cls, payload: Mapping[str, Any]) -> "ShapeGeometryProvenance":
        source = _text(payload, "source")
        precision = _text(payload, "precision")
        return cls(
            source=cast(Literal["parametric", "brep", "mesh"], source) if source in ("parametric", "brep", "mesh") else "parametric",
            precision=cast(Literal["exact", "tessellated"], precision) if precision in ("exact", "tessellated") else "exact",
        )


@dataclass(frozen=True)
class ShapeProperties:
    volume: float
    area: float
    center_of_mass: Mapping[str, float]
    bbox: Mapping[str, float]
    is_valid: bool
    provenance: ShapeGeometryProvenance

    @classmethod
    def from_payload(cls, payload: Mapping[str, Any]) -> "ShapeProperties":
        center = payload.get("centerOfMass")
        bbox = payload.get("bbox")
        return cls(
            volume=_number(payload, "volume"), area=_number(payload, "area"),
            center_of_mass=dict(center) if isinstance(center, Mapping) else {},
            bbox=dict(bbox) if isinstance(bbox, Mapping) else {},
            is_valid=bool(payload.get("isValid")),
            provenance=ShapeGeometryProvenance.from_payload(payload.get("provenance", {})),
        )


@dataclass(frozen=True)
class ShapeWriteResult:
    shapes: List[ShapeSummary]
    revision: int


@dataclass(frozen=True)
class ListPage(Generic[TPageItem]):
    items: List[TPageItem]
    next_cursor: Optional[str]


@dataclass(frozen=True)
class ShapeOperationResult:
    shape: ShapeSummary
    revision: int


@dataclass(frozen=True)
class BooleanCutResult:
    shape: ShapeSummary
    triangles: int
    revision: int


@dataclass(frozen=True)
class ShapeCollectionResult:
    shapes: List[ShapeSummary]
    revision: int


@dataclass(frozen=True)
class ExportResult:
    format: ExportFormat
    filename: str
    mime_type: str
    data: bytes
    shape_count: int
    exported_count: Optional[int] = None
    skipped: List[Dict[str, Any]] = field(default_factory=list)


@dataclass(frozen=True)
class TreatmentResult:
    shape: ShapeSummary
    triangles: int
    revision: int


#: Hollowing answers with the same three fields a treatment does.
ShellResult = TreatmentResult

#: ``x`` is left/right, ``z`` front/back, ``y`` bottom/top.
ALIGN_AXES = ("x", "y", "z")

#: Which edge or centre of each shape to line up.
ALIGN_TARGETS = ("min", "center", "max")

#: ``gaps`` leaves equal clear space; ``centers`` puts the centres at an equal pitch.
DISTRIBUTE_SPACINGS = ("gaps", "centers")

PATTERN_KINDS = ("linear", "circular")

MIN_PATTERN_COUNT = 2
MAX_PATTERN_COUNT = 200

#: The model file formats the server reads with no browser and no CAD kernel.
IMPORTABLE_MESH_FORMATS = ("stl", "obj", "svg")


@dataclass(frozen=True)
class AlignResult:
    """What an alignment did.

    ``moved`` is the answer to "did anything happen": a selection that was
    already flush reports zero, nothing is written, and ``revision`` comes back
    where it was.

    ``anchor_id`` is the shape everything else lined up against, which is not
    necessarily the one that was asked for -- a locked shape in the selection
    cannot move, so it anchors the alignment instead.
    """

    moved: int
    axis: str
    target: str
    anchor_id: Optional[str]
    shapes: List[ShapeSummary]
    revision: int

    @classmethod
    def from_payload(cls, payload: Mapping[str, Any]) -> "AlignResult":
        anchor = payload.get("anchorId")
        return cls(
            moved=int(_number(payload, "moved")),
            axis=_text(payload, "axis"),
            target=_text(payload, "target"),
            anchor_id=anchor if isinstance(anchor, str) else None,
            shapes=[ShapeSummary.from_payload(entry) for entry in payload.get("shapes", [])],
            revision=int(_number(payload, "revision")),
        )


@dataclass(frozen=True)
class BakedMirrorResult:
    """Exact reflection of selected parameter-built solids across their shared bounds plane."""

    moved: int
    axis: str
    shapes: List[ShapeSummary]
    revision: int

    @classmethod
    def from_payload(cls, payload: Mapping[str, Any]) -> "BakedMirrorResult":
        return cls(
            moved=int(_number(payload, "moved")),
            axis=_text(payload, "axis"),
            shapes=[ShapeSummary.from_payload(entry) for entry in payload.get("shapes", [])],
            revision=int(_number(payload, "revision")),
        )


@dataclass(frozen=True)
class DistributeResult:
    """What a distribution did, and along which axis it decided to work.

    ``axis`` is worth reading even when it was sent: left out, the server picks
    whichever axis the shapes are already most spread along, and this says
    which one that was.
    """

    moved: int
    axis: str
    spacing: str
    shapes: List[ShapeSummary]
    revision: int

    @classmethod
    def from_payload(cls, payload: Mapping[str, Any]) -> "DistributeResult":
        return cls(
            moved=int(_number(payload, "moved")),
            axis=_text(payload, "axis"),
            spacing=_text(payload, "spacing"),
            shapes=[ShapeSummary.from_payload(entry) for entry in payload.get("shapes", [])],
            revision=int(_number(payload, "revision")),
        )


@dataclass(frozen=True)
class PatternResult:
    """The copies a pattern added. ``created`` excludes the original."""

    created: int
    kind: str
    shapes: List[ShapeSummary]
    revision: int

    @classmethod
    def from_payload(cls, payload: Mapping[str, Any]) -> "PatternResult":
        return cls(
            created=int(_number(payload, "created")),
            kind=_text(payload, "kind"),
            shapes=[ShapeSummary.from_payload(entry) for entry in payload.get("shapes", [])],
            revision=int(_number(payload, "revision")),
        )


#: An import answers with the same three fields a treatment does.
MeshImportResult = TreatmentResult
