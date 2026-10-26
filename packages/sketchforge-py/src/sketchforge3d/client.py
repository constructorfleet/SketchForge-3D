"""
The client, and the project handle a macro actually works through.

Resources are plain objects hanging off the client, each owning one route. A
route added to the API later is a new class here and one more attribute; nothing
in the transport or the handle needs to know about it.
"""

from __future__ import annotations

import base64
import json
import os
import urllib.parse
from typing import Any, Dict, Iterable, List, Literal, Mapping, Optional, Sequence, Tuple, Union, cast, overload

from ._http import DEFAULT_RETRY_ON_BUSY, DEFAULT_TIMEOUT_SECONDS, Transport
from .errors import SketchForgeApiError, SketchForgeTransportError
from .types import (
    IMPORTABLE_MESH_FORMATS,
    MAX_SHAPES_PER_REQUEST,
    AlignResult,
    BakedMirrorResult,
    BooleanCutResult,
    DistributeResult,
    EdgeSummary,
    ExportFormat,
    ExportSection,
    ExportView,
    ExportResult,
    FaceSummary,
    MeasurementEnd,
    MeasurementPair,
    MeasurementSummary,
    InterferenceReport,
    ListPage,
    ShapeProperties,
    MeshImportResult,
    PatternResult,
    ProjectDetail,
    ProjectSummary,
    ShapePatch,
    ShapeCollectionResult,
    ShapeOperationResult,
    ShapeRequest,
    ShapeSpec,
    ShapeSummary,
    ShapeWriteResult,
    ShellResult,
    TreatmentResult,
    WallThicknessEstimate,
)


def chunk(items: Sequence[Any], size: int) -> List[List[Any]]:
    """Splits into runs of at most ``size``."""
    if size < 1:
        raise ValueError("A chunk size must be at least 1.")
    return [list(items[start : start + size]) for start in range(0, len(items), size)]


def _listing_query(limit: Optional[int], cursor: Optional[str]) -> Dict[str, str]:
    if limit is not None and (isinstance(limit, bool) or not 1 <= limit <= 1000):
        raise ValueError("A listing limit must be between 1 and 1000.")
    return {
        **({"limit": str(limit)} if limit is not None else {}),
        **({"cursor": cursor} if cursor is not None else {}),
    }


class Projects:
    def __init__(self, transport: Transport) -> None:
        self._transport = transport

    def list(self) -> List[ProjectSummary]:
        payload = self._transport.send("GET", "/projects") or {}
        return [ProjectSummary.from_payload(entry) for entry in payload.get("projects", [])]

    def list_page(self, limit: Optional[int] = None, cursor: Optional[str] = None) -> ListPage[ProjectSummary]:
        query = _listing_query(limit, cursor)
        payload = self._transport.send("GET", "/projects", query or None) or {}
        return ListPage([ProjectSummary.from_payload(entry) for entry in payload.get("projects", [])], payload.get("nextCursor"))

    def get(self, project_id: str) -> ProjectDetail:
        payload = self._transport.send("GET", "/projects", {"projectId": project_id}) or {}
        return ProjectDetail.from_payload(payload.get("project") or {})

    def create(self, name: str) -> ProjectSummary:
        """The server truncates a name to 80 characters and refuses an empty one."""
        payload = self._transport.send("POST", "/projects", body={"name": name}, retryable=True) or {}
        return ProjectSummary.from_payload(payload.get("project") or {})

    def delete(self, project_id: str) -> bool:
        payload = self._transport.send(
            "DELETE", "/projects", {"projectId": project_id}, retryable=True
        ) or {}
        return bool(payload.get("deleted"))

    def find_by_name(self, name: str) -> Optional[ProjectSummary]:
        """The first project with this name, or None. Names are not unique server-side."""
        for project in self.list():
            if project.name == name:
                return project
        return None


class Shapes:
    def __init__(self, transport: Transport) -> None:
        self._transport = transport

    def list(self, project_id: str) -> List[ShapeSummary]:
        payload = self._transport.send("GET", "/shapes", {"projectId": project_id}) or {}
        return [ShapeSummary.from_payload(entry) for entry in payload.get("shapes", [])]

    def list_page(self, project_id: str, limit: Optional[int] = None, cursor: Optional[str] = None) -> ListPage[ShapeSummary]:
        query = {"projectId": project_id, **_listing_query(limit, cursor)}
        payload = self._transport.send("GET", "/shapes", query) or {}
        return ListPage([ShapeSummary.from_payload(entry) for entry in payload.get("shapes", [])], payload.get("nextCursor"))

    @overload
    def create(self, project_id: str, shape: ShapeSpec) -> ShapeSummary: pass

    @overload
    def create(self, project_id: str, shape: ShapeRequest) -> ShapeSummary: pass

    def create(self, project_id: str, shape: ShapeRequest) -> ShapeSummary:
        payload = self._transport.send(
            "POST", "/shapes", {"projectId": project_id}, dict(shape), retryable=True
        ) or {}
        created = payload.get("shapes") or []
        if not created:
            raise SketchForgeApiError("POST", "/shapes", 500, "the server returned no shape")
        return ShapeSummary.from_payload(created[0])

    @overload
    def create_many(self, project_id: str, shapes: Iterable[ShapeSpec]) -> ShapeWriteResult: pass

    @overload
    def create_many(self, project_id: str, shapes: Iterable[ShapeRequest]) -> ShapeWriteResult: pass

    def create_many(self, project_id: str, shapes: Iterable[ShapeRequest]) -> ShapeWriteResult:
        """
        A batch, in request order.

        One request is one write of the project package, so a row of forty holes
        should be one call rather than forty. A list longer than the server's
        limit is split, which means it is no longer atomic: a later chunk can
        fail with earlier ones already written.
        """
        requested = [dict(shape) for shape in shapes]
        if not requested:
            return ShapeWriteResult(shapes=[], revision=0)

        created: List[ShapeSummary] = []
        revision = 0
        for batch in chunk(requested, MAX_SHAPES_PER_REQUEST):
            payload = self._transport.send(
                "POST", "/shapes", {"projectId": project_id}, {"shapes": batch}, retryable=True
            ) or {}
            created.extend(ShapeSummary.from_payload(entry) for entry in payload.get("shapes", []))
            revision = int(payload.get("revision") or 0)
        return ShapeWriteResult(shapes=created, revision=revision)

    def update(self, project_id: str, shape_id: str, changes: ShapePatch) -> ShapeSummary:
        """Changes the fields given and leaves the rest. A locked shape needs ``locked=False``."""
        payload = self._transport.send(
            "PATCH",
            "/shapes",
            {"projectId": project_id, "shapeId": shape_id},
            dict(changes),
            retryable=True,
        ) or {}
        return ShapeSummary.from_payload(payload.get("shape") or {})

    def delete(self, project_id: str, shape_id: str) -> bool:
        payload = self._transport.send(
            "DELETE", "/shapes", {"projectId": project_id, "shapeId": shape_id}, retryable=True
        ) or {}
        return bool(payload.get("deleted"))

    def delete_all(self, project_id: str) -> int:
        """
        Empties the project, one delete at a time.

        There is no bulk delete and each call rewrites the package, which is why
        a macro wanting a clean slate is usually better off with a new project.
        """
        shapes = self.list(project_id)
        for shape in shapes:
            if shape.locked:
                self.update(project_id, shape.id, {"locked": False})
            self.delete(project_id, shape.id)
        return len(shapes)


class Edges:
    def __init__(self, transport: Transport) -> None:
        self._transport = transport

    def list(self, project_id: str, shape_id: str) -> List[EdgeSummary]:
        payload = self._transport.send(
            "GET", "/edges", {"projectId": project_id, "shapeId": shape_id}
        ) or {}
        return [EdgeSummary.from_payload(entry) for entry in payload.get("edges", [])]

    def filletable_indexes(self, project_id: str, shape_id: str) -> List[int]:
        return [edge.index for edge in self.list(project_id, shape_id) if edge.filletable]


class Treatments:
    def __init__(self, transport: Transport) -> None:
        self._transport = transport

    def apply(
        self,
        project_id: str,
        shape_id: str,
        kind: str,
        amount: float,
        angle: Optional[float] = None,
        edges: Optional[Sequence[int]] = None,
    ) -> TreatmentResult:
        """
        Rounds or cuts edges on the server, with OCCT.

        Treat every edge you want in one request where you can: OCCT refuses a
        second treatment on edges adjacent to the first, because the surfaces
        there are already tangent.
        """
        body: Dict[str, Any] = {"kind": kind, "amount": amount}
        if angle is not None:
            body["angle"] = angle
        if edges is not None:
            body["edges"] = list(edges)
        payload = self._transport.send(
            "POST",
            "/treatments",
            {"projectId": project_id, "shapeId": shape_id},
            body,
            retryable=True,
        ) or {}
        return TreatmentResult(
            shape=ShapeSummary.from_payload(payload.get("shape") or {}),
            triangles=int(payload.get("triangles") or 0),
            revision=int(payload.get("revision") or 0),
        )

    def fillet(
        self, project_id: str, shape_id: str, radius: float, edges: Optional[Sequence[int]] = None
    ) -> TreatmentResult:
        return self.apply(project_id, shape_id, "fillet", radius, edges=edges)

    def chamfer(
        self,
        project_id: str,
        shape_id: str,
        distance: float,
        angle: Optional[float] = None,
        edges: Optional[Sequence[int]] = None,
    ) -> TreatmentResult:
        return self.apply(project_id, shape_id, "chamfer", distance, angle=angle, edges=edges)


class DraftPrisms:
    def __init__(self, transport: Transport) -> None:
        self._transport = transport

    def apply(self, project_id: str, shape_id: str, angle: float) -> TreatmentResult:
        """Draft a retained straight polygon sketch extrusion on the server."""
        payload = self._transport.send(
            "POST",
            "/draft-prism",
            {"projectId": project_id, "shapeId": shape_id},
            {"angle": angle},
            retryable=True,
        ) or {}
        return TreatmentResult(
            shape=ShapeSummary.from_payload(payload.get("shape") or {}),
            triangles=int(payload.get("triangles") or 0),
            revision=int(payload.get("revision") or 0),
        )


class Faces:
    def __init__(self, transport: Transport) -> None:
        self._transport = transport

    def list(
        self, project_id: str, shape_id: str, *,
        topology: Optional[Literal["mesh", "exact"]] = None,
    ) -> List[FaceSummary]:
        payload = self._transport.send(
            "GET", "/faces", {"projectId": project_id, "shapeId": shape_id, "topology": topology}
        ) or {}
        return [FaceSummary.from_payload(entry) for entry in payload.get("faces", [])]

    def facing(self, project_id: str, shape_id: str, direction: str) -> List[int]:
        """
        The indexes of the faces pointing a given way, which is usually one.

        A shell request can name the direction itself, so this is for a caller
        that wants to know what it would get first -- or to find out that this
        shape has no flat face pointing that way before asking for its lid off.
        """
        return [
            face.index
            for face in self.list(project_id, shape_id)
            if face.facing == direction
        ]

    def ids_facing(self, project_id: str, shape_id: str, direction: str) -> List[str]:
        """
        The stable ids of the faces pointing a given way.

        The sibling of :meth:`facing`, which answers with indexes. An index is
        only true until the next operation reorders the faces, so this is the
        form to persist -- a face color is keyed by id.
        """
        return [
            face.id
            for face in self.list(project_id, shape_id)
            if face.facing == direction and face.id is not None
        ]


def _measurement_end(end: MeasurementEnd) -> Dict[str, Any]:
    """
    One end of a between-entities request, as the server wants it.

    An absent ``entity`` and an absent ``index`` are left out rather than sent
    as null: the server reads a missing ``entity`` as the whole shape, and
    refuses an ``index`` alongside it.
    """
    body: Dict[str, Any] = {"shapeId": end.get("shapeId")}
    for key in ("entity", "index"):
        if end.get(key) is not None:
            body[key] = end[key]
    return body


class Measurements:
    def __init__(self, transport: Transport) -> None:
        self._transport = transport

    def list(self, project_id: str, shape_id: str) -> List[MeasurementSummary]:
        """Every edge and face, measured, numbered as the edge and face listings number them."""
        payload = self._transport.send(
            "GET", "/measurements", {"projectId": project_id, "shapeId": shape_id}
        ) or {}
        return [MeasurementSummary.from_payload(entry) for entry in payload.get("measurements", [])]

    def between(self, project_id: str, from_: MeasurementEnd, to: MeasurementEnd) -> MeasurementPair:
        """
        The distance between two entities, and the angle if both are flat faces.

        The ends may be on different shapes, and either may be a whole shape, so
        this answers both "how deep is that pocket" and "how far apart are those
        two parts". The distance is measured between the real surfaces, so two
        cylinders 5mm apart at their nearest walls read 5.
        """
        payload = self._transport.send(
            "POST",
            "/measurements",
            {"projectId": project_id},
            {"from": _measurement_end(from_), "to": _measurement_end(to)},
        ) or {}
        return MeasurementPair.from_payload(payload)

    def with_radius(self, project_id: str, shape_id: str) -> List[MeasurementSummary]:
        """
        The entries that carry a radius, which is how a caller finds the bores.

        Most entities of a shape have none -- a flat face and a straight edge
        both answer with a reason instead -- so filtering on the reported radius
        is what a caller wanting the round features has to do anyway.
        """
        return [
            measurement
            for measurement in self.list(project_id, shape_id)
            if measurement.radius is not None
        ]


class Properties:
    def __init__(self, transport: Transport) -> None:
        self._transport = transport

    def get(self, project_id: str, shape_id: str) -> ShapeProperties:
        """Exact mass properties and geometry provenance for one shape."""
        payload = self._transport.send(
            "GET", "/properties", {"projectId": project_id, "shapeId": shape_id}
        ) or {}
        return ShapeProperties.from_payload(payload.get("properties", {}))


class Interference:
    def __init__(self, transport: Transport) -> None:
        self._transport = transport

    def check(
        self,
        project_id: str,
        ids: Optional[Sequence[str]] = None,
        clearance: Optional[float] = None,
    ) -> InterferenceReport:
        """Check exact gaps and penetration; the server refuses requests above its work caps."""
        body: Dict[str, Any] = {}
        if ids is not None:
            body["ids"] = list(ids)
        if clearance is not None:
            body["clearance"] = clearance
        payload = self._transport.send("POST", "/interference", {"projectId": project_id}, body) or {}
        return InterferenceReport.from_payload(payload)


class Shell:
    def __init__(self, transport: Transport) -> None:
        self._transport = transport

    def apply(
        self,
        project_id: str,
        shape_id: str,
        thickness: float,
        open_faces: Optional[Sequence[Union[str, int]]] = None,
    ) -> ShellResult:
        """
        Hollows a solid out on the server, with OCCT.

        The result is exact, so it still exports to STEP and can still be
        filleted. Not every shape can be hollowed: a sphere, a torus, a cone
        and a tube's round wall are each one continuous curved surface, and
        OCCT refuses to offset them inwards at any thickness.
        """
        body: Dict[str, Any] = {"thickness": thickness}
        if open_faces is not None:
            body["openFaces"] = list(open_faces)
        payload = self._transport.send(
            "POST",
            "/shell",
            {"projectId": project_id, "shapeId": shape_id},
            body,
            retryable=True,
        ) or {}
        return ShellResult(
            shape=ShapeSummary.from_payload(payload.get("shape") or {}),
            triangles=int(payload.get("triangles") or 0),
            revision=int(payload.get("revision") or 0),
        )

    def hollow(self, project_id: str, shape_id: str, thickness: float) -> ShellResult:
        """A sealed hollow: a wall all the way round, with the void closed in."""
        return self.apply(project_id, shape_id, thickness)

    def tray(
        self,
        project_id: str,
        shape_id: str,
        thickness: float,
        open_faces: Optional[Sequence[Union[str, int]]] = None,
    ) -> ShellResult:
        """The usual print: a box with its lid off, which is a tray."""
        return self.apply(
            project_id, shape_id, thickness, ["top"] if open_faces is None else open_faces
        )


class Booleans:
    """Subtracts one or more cutter shapes from one or more solids."""

    def __init__(self, transport: Transport) -> None:
        self._transport = transport

    def cut(
        self, project_id: str, solid_ids: Sequence[str], hole_ids: Sequence[str]
    ) -> BooleanCutResult:
        payload = self._transport.send(
            "POST",
            "/booleans",
            {"projectId": project_id},
            {"solidIds": list(solid_ids), "holeIds": list(hole_ids)},
            retryable=True,
        ) or {}
        return BooleanCutResult(
            shape=ShapeSummary.from_payload(payload.get("shape") or {}),
            triangles=int(payload.get("triangles") or 0),
            revision=int(payload.get("revision") or 0),
        )


class Groups:
    """Groups shapes, including subtracting members marked as holes."""

    def __init__(self, transport: Transport) -> None:
        self._transport = transport

    def group(self, project_id: str, ids: Sequence[str]) -> ShapeOperationResult:
        payload = self._transport.send(
            "POST", "/groups", {"projectId": project_id}, {"ids": list(ids)}, retryable=True
        ) or {}
        return ShapeOperationResult(
            shape=ShapeSummary.from_payload(payload.get("shape") or {}),
            revision=int(payload.get("revision") or 0),
        )

    def ungroup(self, project_id: str, shape_id: str) -> ShapeCollectionResult:
        payload = self._transport.send(
            "DELETE", "/groups", {"projectId": project_id, "shapeId": shape_id}, retryable=True
        ) or {}
        return ShapeCollectionResult(
            shapes=[ShapeSummary.from_payload(shape) for shape in payload.get("shapes") or []],
            revision=int(payload.get("revision") or 0),
        )


class Parts:
    """Separates a cut or grouped shape into its independent bodies."""

    def __init__(self, transport: Transport) -> None:
        self._transport = transport

    def separate(self, project_id: str, shape_id: str) -> ShapeCollectionResult:
        payload = self._transport.send(
            "POST", "/parts", {"projectId": project_id, "shapeId": shape_id}, retryable=True
        ) or {}
        return ShapeCollectionResult(
            shapes=[ShapeSummary.from_payload(shape) for shape in payload.get("shapes") or []],
            revision=int(payload.get("revision") or 0),
        )


class Explosions:
    """Explodes an imported STEP assembly into its component solids."""

    def __init__(self, transport: Transport) -> None:
        self._transport = transport

    def explode(self, project_id: str, shape_id: str) -> ShapeCollectionResult:
        payload = self._transport.send(
            "POST", "/explode", {"projectId": project_id, "shapeId": shape_id}, {}, retryable=True
        ) or {}
        return ShapeCollectionResult(
            shapes=[ShapeSummary.from_payload(shape) for shape in payload.get("shapes") or []],
            revision=int(payload.get("revision") or 0),
        )


class Thickness:
    """Samples opposing surfaces to estimate wall thickness."""

    def __init__(self, transport: Transport) -> None:
        self._transport = transport

    def estimate(self, project_id: str, shape_id: str) -> WallThicknessEstimate:
        payload = self._transport.send(
            "GET", "/thickness", {"projectId": project_id, "shapeId": shape_id}
        ) or {}
        return WallThicknessEstimate.from_payload(payload.get("thickness") or {})


class Align:
    """Puts one edge or one centre of every named shape on the same coordinate.

    ``ids`` is required. There is no selection on a server, which is the one
    thing the editor has and the API does not.
    """

    def __init__(self, transport: Transport) -> None:
        self._transport = transport

    def apply(
        self,
        project_id: str,
        ids: Sequence[str],
        axis: str,
        target: str,
        anchor_id: Optional[str] = None,
    ) -> AlignResult:
        """``axis`` is x/y/z and ``target`` is min/center/max.

        Together they are the editor's own nine alignment handles: ``x`` with
        ``min`` is its Left, ``y`` with ``max`` its Top. With no anchor the
        reference is the box around the whole selection.
        """
        body: Dict[str, Any] = {"ids": list(ids), "axis": axis, "target": target}
        # An anchor sent as null is a different request from one not sent: the
        # server reads an absent one as "use the whole selection's box".
        if anchor_id is not None:
            body["anchorId"] = anchor_id
        payload = self._transport.send(
            "POST", "/align", {"projectId": project_id}, body, retryable=True
        ) or {}
        return AlignResult.from_payload(payload)

    def tops(self, project_id: str, ids: Sequence[str], anchor_id: Optional[str] = None) -> AlignResult:
        """Flush tops, which is the alignment a row of parts on a plate usually wants."""
        return self.apply(project_id, ids, "y", "max", anchor_id)

    def bottoms(self, project_id: str, ids: Sequence[str], anchor_id: Optional[str] = None) -> AlignResult:
        """Seated on one plane: every underside at the same elevation."""
        return self.apply(project_id, ids, "y", "min", anchor_id)

    def centers(
        self, project_id: str, ids: Sequence[str], axis: str, anchor_id: Optional[str] = None
    ) -> AlignResult:
        """Centred on one another along an axis."""
        return self.apply(project_id, ids, axis, "center", anchor_id)


class Mirrors:
    """Exact CAD mirror operations for parameter-built solids."""

    def __init__(self, transport: Transport) -> None:
        self._transport = transport

    def bake(self, project_id: str, ids: Sequence[str], axis: str) -> BakedMirrorResult:
        """Reflects named solids over their combined bounds midpoint and stores exact BREP."""
        payload = self._transport.send(
            "POST", "/mirrors", {"projectId": project_id}, {"ids": list(ids), "axis": axis}, retryable=True
        ) or {}
        return BakedMirrorResult.from_payload(payload)


class Distribute:
    """Spreads three or more shapes evenly along an axis.

    The outermost two never move: they define the span, which is the one thing
    the caller has already decided.
    """

    def __init__(self, transport: Transport) -> None:
        self._transport = transport

    def apply(
        self,
        project_id: str,
        ids: Sequence[str],
        axis: Optional[str] = None,
        spacing: Optional[str] = None,
    ) -> DistributeResult:
        """Leave ``axis`` out to use whichever one the shapes are already most spread along."""
        body: Dict[str, Any] = {"ids": list(ids)}
        if axis is not None:
            body["axis"] = axis
        if spacing is not None:
            body["spacing"] = spacing
        payload = self._transport.send(
            "POST", "/distribute", {"projectId": project_id}, body, retryable=True
        ) or {}
        return DistributeResult.from_payload(payload)

    def gaps(self, project_id: str, ids: Sequence[str], axis: Optional[str] = None) -> DistributeResult:
        """Equal clear space between neighbours: the one for parts of different sizes."""
        return self.apply(project_id, ids, axis, "gaps")

    def pitch(self, project_id: str, ids: Sequence[str], axis: Optional[str] = None) -> DistributeResult:
        """Equal centre-to-centre pitch: the one a row of holes wants."""
        return self.apply(project_id, ids, axis, "centers")


class Patterns:
    """Repeats shapes in a row or around a ring, adding the copies."""

    def __init__(self, transport: Transport) -> None:
        self._transport = transport

    def apply(
        self,
        project_id: str,
        ids: Sequence[str],
        kind: Optional[str] = None,
        count: Optional[int] = None,
        step_x: Optional[float] = None,
        step_z: Optional[float] = None,
        center_x: Optional[float] = None,
        center_z: Optional[float] = None,
        sweep_angle: Optional[float] = None,
        rotate_copies: Optional[bool] = None,
    ) -> PatternResult:
        """``count`` includes the original, so 4 adds 3. From 2 to 200."""
        body: Dict[str, Any] = {"ids": list(ids)}
        for key, value in (
            ("kind", kind),
            ("count", count),
            ("stepX", step_x),
            ("stepZ", step_z),
            ("centerX", center_x),
            ("centerZ", center_z),
            ("sweepAngle", sweep_angle),
            ("rotateCopies", rotate_copies),
        ):
            # Against `if value:` deliberately. A zero step is a row running
            # purely along the other axis, a zero centre is the origin, and
            # `rotate_copies=False` is a vane keeping its heading -- all three
            # are meaningful and all three are falsy.
            if value is not None:
                body[key] = value
        payload = self._transport.send(
            "POST", "/patterns", {"projectId": project_id}, body, retryable=True
        ) or {}
        return PatternResult.from_payload(payload)

    def row(
        self,
        project_id: str,
        ids: Sequence[str],
        count: int,
        step_x: float,
        step_z: Optional[float] = None,
    ) -> PatternResult:
        """A row at a centre-to-centre pitch.

        The step is a pitch rather than a gap, because "four at 25mm" is
        unambiguous and "four with 25mm between them" depends on how wide the
        shapes are.
        """
        return self.apply(project_id, ids, "linear", count, step_x=step_x, step_z=step_z)

    def ring(
        self,
        project_id: str,
        ids: Sequence[str],
        count: int,
        center: Tuple[float, float] = (0.0, 0.0),
        sweep_angle: Optional[float] = None,
        rotate_copies: Optional[bool] = None,
    ) -> PatternResult:
        """A ring about a point, which is how a bolt circle is made.

        A full turn divides by the count, so six land every 60 degrees and the
        last does not sit on the first. A partial ``sweep_angle`` divides by the
        gaps instead, putting one copy at each end.
        """
        return self.apply(
            project_id,
            ids,
            "circular",
            count,
            center_x=center[0],
            center_z=center[1],
            sweep_angle=sweep_angle,
            rotate_copies=rotate_copies,
        )


class Imports:
    """Adds the model a file describes, and keeps the file with the project.

    The source file is stored as a project asset and the shape points at it,
    both in one write -- a shape stored without its asset loses its geometry
    the next time the project is saved.
    """

    def __init__(self, transport: Transport) -> None:
        self._transport = transport

    def apply(
        self,
        project_id: str,
        file_name: str,
        data: bytes,
        media_type: Optional[str] = None,
    ) -> MeshImportResult:
        """``stl``, ``obj`` and ``svg``.

        ``file_name`` is not decoration: it chooses the importer, it names the
        stored asset, and for an STL it decides which way is up -- a slicer
        writes Z-up and SketchForge's own older exports are Y-up, recognised by
        the word in the file header.

        A STEP file is refused with ``unsupported_format``: reading one needs
        the CAD kernel the editor loads in a browser.
        """
        body: Dict[str, Any] = {
            "fileName": file_name,
            "data": base64.b64encode(data).decode("ascii"),
        }
        if media_type is not None:
            body["mediaType"] = media_type
        payload = self._transport.send(
            "POST", "/imports", {"projectId": project_id}, body, retryable=True
        ) or {}
        return MeshImportResult(
            shape=ShapeSummary.from_payload(payload.get("shape") or {}),
            triangles=int(payload.get("triangles") or 0),
            revision=int(payload.get("revision") or 0),
        )

    def file(self, project_id: str, path: Union[str, "os.PathLike[str]"]) -> MeshImportResult:
        """Multipart upload of a path, avoiding base64 and JSON expansion."""
        resolved = os.fspath(path)
        with open(resolved, "rb") as handle:
            data = handle.read()
        file_name = os.path.basename(resolved)
        media_type = {
            "stl": "model/stl",
            "obj": "model/obj",
            "svg": "image/svg+xml",
        }.get(file_name.rsplit(".", 1)[-1].lower())
        payload = self._transport.send_multipart(
            "POST",
            "/imports",
            {"projectId": project_id},
            {"fileName": file_name},
            file_name,
            data,
            media_type,
            retryable=True,
        ) or {}
        return MeshImportResult(
            shape=ShapeSummary.from_payload(payload.get("shape") or {}),
            triangles=int(payload.get("triangles") or 0),
            revision=int(payload.get("revision") or 0),
        )

    @staticmethod
    def readable(file_name: str) -> bool:
        """Whether this file's name is one the server will try to read at all."""
        suffix = file_name.rsplit(".", 1)[-1].lower() if "." in file_name else ""
        return suffix in IMPORTABLE_MESH_FORMATS


class Exports:
    """Exports a server-stored project or selected shapes to a local file format."""

    def __init__(self, transport: Transport) -> None:
        self._transport = transport

    @staticmethod
    def _body(
        format: ExportFormat,
        shape_ids: Optional[Sequence[str]],
        name: Optional[str],
        view: Optional[ExportView],
        section: Optional[ExportSection],
    ) -> Dict[str, Any]:
        body: Dict[str, Any] = {"format": format}
        if shape_ids is not None:
            body["shapeIds"] = list(shape_ids)
        if name is not None:
            body["name"] = name
        if view is not None:
            body["view"] = view
        if section is not None:
            body["section"] = dict(section)
        return body

    def export(
        self,
        project_id: str,
        format: ExportFormat,
        shape_ids: Optional[Sequence[str]] = None,
        name: Optional[str] = None,
        view: Optional[ExportView] = None,
        section: Optional[ExportSection] = None,
    ) -> ExportResult:
        """``view`` projects SVG; ``section`` returns contours cut by a named plane."""
        body = self._body(format, shape_ids, name, view, section)
        payload = self._transport.send(
            "POST", "/exports", {"projectId": project_id}, body, retryable=False
        ) or {}
        export_format = payload.get("format") or format
        if export_format not in ("stl", "obj", "3mf", "step", "skf", "zip", "svg", "dxf"):
            export_format = format
        return ExportResult(
            format=cast(ExportFormat, export_format),
            filename=str(payload.get("filename") or "export"),
            mime_type=str(payload.get("mimeType") or "application/octet-stream"),
            data=base64.b64decode(payload.get("base64") or "", validate=True),
            shape_count=int(payload.get("shapeCount") or 0),
            exported_count=(int(payload["exportedCount"]) if isinstance(payload.get("exportedCount"), (int, float)) else None),
            skipped=list(payload.get("skipped") or []),
        )

    def file(
        self,
        project_id: str,
        format: ExportFormat,
        path: Union[str, "os.PathLike[str]"],
        shape_ids: Optional[Sequence[str]] = None,
        name: Optional[str] = None,
        view: Optional[ExportView] = None,
        section: Optional[ExportSection] = None,
    ) -> ExportResult:
        body = self._body(format, shape_ids, name, view, section)
        headers = self._transport.download_to_file(
            "POST",
            "/exports",
            {"projectId": project_id, "download": 1},
            body,
            os.fspath(path),
        )
        metadata_raw = urllib.parse.unquote(headers.get("x-sketchforge-metadata", ""))
        metadata = json.loads(metadata_raw) if metadata_raw else {}
        export_format = metadata.get("format") or format
        if export_format not in ("stl", "obj", "3mf", "step", "skf", "zip", "svg", "dxf"):
            export_format = format
        return ExportResult(
            format=cast(ExportFormat, export_format),
            filename=str(metadata.get("filename") or os.path.basename(os.fspath(path))),
            mime_type=str(metadata.get("mimeType") or headers.get("content-type") or "application/octet-stream"),
            data=b"",
            shape_count=int(metadata.get("shapeCount") or 0),
            exported_count=(int(metadata["exportedCount"]) if isinstance(metadata.get("exportedCount"), (int, float)) else None),
            skipped=list(metadata.get("skipped") or []),
        )


# REST operation ids implemented by each public client resource. Keep this
# inventory beside the client resource construction list so parity tests can
# compare it with the server's operation registry.
CLIENT_RESOURCE_OPERATIONS = {
    "projects": {"listProjectsOrGetProject": ("list",), "createProject": ("create",), "deleteProject": ("delete",)},
    "shapes": {"listShapes": ("list",), "createShapes": ("create",), "updateShape": ("update",), "deleteShape": ("delete",)},
    "edges": {"listEdges": ("list",)},
    "faces": {"listFaces": ("list",)},
    "measurements": {"listMeasurements": ("list",), "measureEntities": ("between",)},
    "properties": {"getShapeProperties": ("get",)},
    "interference": {"analyzeInterference": ("check",)},
    "treatments": {"treatShape": ("apply",)},
    "draft_prisms": {"draftPrism": ("apply",)},
    "shell": {"shellShape": ("apply",)},
    "booleans": {"booleanShapes": ("cut",)},
    "groups": {"groupShapes": ("group",), "ungroupShape": ("ungroup",)},
    "parts": {"splitParts": ("separate",)},
    "explosions": {"explodeAssembly": ("explode",)},
    "thickness": {"estimateThickness": ("estimate",)},
    "align": {"alignShapes": ("apply",)},
    "mirrors": {"mirrorShapes": ("bake",)},
    "distribute": {"distributeShapes": ("apply",)},
    "patterns": {"patternShapes": ("apply",)},
    "imports": {"importGeometry": ("apply",)},
    "exports": {"exportProject": ("export",)},
}


class SketchForgeClient:
    def __init__(
        self,
        base_url: str,
        token: str,
        timeout: float = DEFAULT_TIMEOUT_SECONDS,
        retry_on_busy: int = DEFAULT_RETRY_ON_BUSY,
        headers: Optional[Mapping[str, str]] = None,
        opener: Optional[Any] = None,
        expected_revision: Optional[Union[int, str]] = None,
    ) -> None:
        self._transport = Transport(
            base_url=base_url,
            token=token,
            timeout=timeout,
            retry_on_busy=retry_on_busy,
            headers=headers,
            opener=opener,
            expected_revision=expected_revision,
        )
        self.projects = Projects(self._transport)
        self.shapes = Shapes(self._transport)
        self.edges = Edges(self._transport)
        self.faces = Faces(self._transport)
        self.measurements = Measurements(self._transport)
        self.properties = Properties(self._transport)
        self.interference = Interference(self._transport)
        self.treatments = Treatments(self._transport)
        self.draft_prisms = DraftPrisms(self._transport)
        self.shell = Shell(self._transport)
        self.booleans = Booleans(self._transport)
        self.groups = Groups(self._transport)
        self.parts = Parts(self._transport)
        self.explosions = Explosions(self._transport)
        self.thickness = Thickness(self._transport)
        self.align = Align(self._transport)
        self.mirrors = Mirrors(self._transport)
        self.distribute = Distribute(self._transport)
        self.patterns = Patterns(self._transport)
        self.imports = Imports(self._transport)
        self.exports = Exports(self._transport)

    @property
    def api_root(self) -> str:
        return self._transport.api_root

    def project(self, project_id: str) -> "ProjectHandle":
        """A view of one project, so a macro does not thread its id through every call."""
        return ProjectHandle(self, project_id)

    def check(self) -> Dict[str, Union[bool, int, str]]:
        """
        Whether the API is reachable, enabled, and has storage.

        Worth calling first in anything interactive: the three ways this fails --
        no token on the server, no project directory, wrong port -- are a 404, a
        503 and a connection error, none of which reads as a misconfiguration.
        """
        try:
            return {"ok": True, "projects": len(self.projects.list())}
        except SketchForgeApiError as error:
            if error.looks_disabled:
                reason = "The server has no SKETCHFORGE_API_TOKEN set, so the API is off."
            elif error.needs_storage:
                reason = "The server has no SKETCHFORGE_PROJECTS_DIR set, so it can store nothing."
            elif error.status == 401:
                reason = "The token was refused."
            else:
                reason = str(error)
            return {"ok": False, "reason": reason}
        except SketchForgeTransportError as error:
            return {"ok": False, "reason": str(error)}


class ProjectHandle:
    def __init__(self, client: SketchForgeClient, project_id: str) -> None:
        self._client = client
        self.id = project_id

    def get(self) -> ProjectDetail:
        return self._client.projects.get(self.id)

    def delete(self) -> bool:
        return self._client.projects.delete(self.id)

    def list_shapes(self) -> List[ShapeSummary]:
        return self._client.shapes.list(self.id)

    @overload
    def add(self, shape: ShapeSpec) -> ShapeSummary: pass

    @overload
    def add(self, shape: ShapeRequest) -> ShapeSummary: pass

    def add(self, shape: ShapeRequest) -> ShapeSummary:
        return self._client.shapes.create(self.id, shape)

    @overload
    def add_many(self, shapes: Iterable[ShapeSpec]) -> ShapeWriteResult: pass

    @overload
    def add_many(self, shapes: Iterable[ShapeRequest]) -> ShapeWriteResult: pass

    def add_many(self, shapes: Iterable[ShapeRequest]) -> ShapeWriteResult:
        return self._client.shapes.create_many(self.id, shapes)

    def update(self, shape_id: str, changes: ShapePatch) -> ShapeSummary:
        return self._client.shapes.update(self.id, shape_id, changes)

    def remove(self, shape_id: str) -> bool:
        return self._client.shapes.delete(self.id, shape_id)

    def clear(self) -> int:
        return self._client.shapes.delete_all(self.id)

    def export(
        self,
        format: ExportFormat,
        shape_ids: Optional[Sequence[str]] = None,
        name: Optional[str] = None,
        view: Optional[ExportView] = None,
        section: Optional[ExportSection] = None,
    ) -> ExportResult:
        """Returns an artifact; SVG accepts either a projected ``view`` or section contours."""
        return self._client.exports.export(self.id, format, shape_ids, name, view, section)

    def export_file(
        self,
        format: ExportFormat,
        path: Union[str, "os.PathLike[str]"],
        shape_ids: Optional[Sequence[str]] = None,
        name: Optional[str] = None,
        view: Optional[ExportView] = None,
        section: Optional[ExportSection] = None,
    ) -> ExportResult:
        """Exports a scene and writes its bytes to a local path."""
        return self._client.exports.file(self.id, format, path, shape_ids, name, view, section)

    def cut(self, solid_ids: Sequence[str], hole_ids: Sequence[str]) -> BooleanCutResult:
        """Subtracts the named holes from the named solids."""
        return self._client.booleans.cut(self.id, solid_ids, hole_ids)

    def group(self, ids: Sequence[str]) -> ShapeOperationResult:
        """Groups shapes; members marked ``hole=True`` are subtracted."""
        return self._client.groups.group(self.id, ids)

    def ungroup(self, shape_id: str) -> ShapeCollectionResult:
        """Restores a group's members as separate project shapes."""
        return self._client.groups.ungroup(self.id, shape_id)

    def separate(self, shape_id: str) -> ShapeCollectionResult:
        """Splits a shape into its disconnected bodies."""
        return self._client.parts.separate(self.id, shape_id)

    def edges(self, shape_id: str) -> List[EdgeSummary]:
        return self._client.edges.list(self.id, shape_id)

    def filletable_edges(self, shape_id: str) -> List[int]:
        return self._client.edges.filletable_indexes(self.id, shape_id)

    def fillet(
        self, shape_id: str, radius: float, edges: Optional[Sequence[int]] = None
    ) -> TreatmentResult:
        return self._client.treatments.fillet(self.id, shape_id, radius, edges)

    def chamfer(
        self,
        shape_id: str,
        distance: float,
        angle: Optional[float] = None,
        edges: Optional[Sequence[int]] = None,
    ) -> TreatmentResult:
        return self._client.treatments.chamfer(self.id, shape_id, distance, angle, edges)

    def explode(self, shape_id: str) -> ShapeCollectionResult:
        return self._client.explosions.explode(self.id, shape_id)

    def estimate_wall_thickness(self, shape_id: str) -> WallThicknessEstimate:
        return self._client.thickness.estimate(self.id, shape_id)

    def faces(
        self, shape_id: str, *, topology: Optional[Literal["mesh", "exact"]] = None,
    ) -> List[FaceSummary]:
        return self._client.faces.list(self.id, shape_id, topology=topology)

    def faces_facing(self, shape_id: str, direction: str) -> List[int]:
        return self._client.faces.facing(self.id, shape_id, direction)

    def measurements(self, shape_id: str) -> List[MeasurementSummary]:
        return self._client.measurements.list(self.id, shape_id)

    def properties_of(self, shape_id: str) -> ShapeProperties:
        return self._client.properties.get(self.id, shape_id)

    def measurements_with_radius(self, shape_id: str) -> List[MeasurementSummary]:
        return self._client.measurements.with_radius(self.id, shape_id)

    def measure_between(self, from_: MeasurementEnd, to: MeasurementEnd) -> MeasurementPair:
        """The distance between two entities, which may be on two different shapes."""
        return self._client.measurements.between(self.id, from_, to)

    def check_interference(
        self, ids: Optional[Sequence[str]] = None, clearance: Optional[float] = None
    ) -> InterferenceReport:
        """Check exact clearances between visible solids in this project."""
        return self._client.interference.check(self.id, ids=ids, clearance=clearance)

    def shell(
        self,
        shape_id: str,
        thickness: float,
        open_faces: Optional[Sequence[Union[str, int]]] = None,
    ) -> ShellResult:
        """Hollows the shape out, sealed unless ``open_faces`` names faces to leave off."""
        return self._client.shell.apply(self.id, shape_id, thickness, open_faces)

    def draft_prism(self, shape_id: str, angle: float) -> TreatmentResult:
        """Draft a retained straight polygon sketch extrusion."""
        return self._client.draft_prisms.apply(self.id, shape_id, angle)

    def hollow(self, shape_id: str, thickness: float) -> ShellResult:
        return self._client.shell.hollow(self.id, shape_id, thickness)

    def tray(
        self,
        shape_id: str,
        thickness: float,
        open_faces: Optional[Sequence[Union[str, int]]] = None,
    ) -> ShellResult:
        return self._client.shell.tray(self.id, shape_id, thickness, open_faces)

    def mirror_baked(self, ids: Sequence[str], axis: str) -> BakedMirrorResult:
        """Reflects exact parameter-built solids across their selection bounds plane."""
        return self._client.mirrors.bake(self.id, ids, axis)

    def align(
        self,
        ids: Sequence[str],
        axis: str,
        target: str,
        anchor_id: Optional[str] = None,
    ) -> AlignResult:
        """Puts one edge or one centre of every named shape on the same coordinate."""
        return self._client.align.apply(self.id, ids, axis, target, anchor_id)

    def align_tops(self, ids: Sequence[str], anchor_id: Optional[str] = None) -> AlignResult:
        """Flush tops, which is the alignment a row of parts on a plate usually wants."""
        return self._client.align.tops(self.id, ids, anchor_id)

    def distribute(
        self,
        ids: Sequence[str],
        axis: Optional[str] = None,
        spacing: Optional[str] = None,
    ) -> DistributeResult:
        """Spreads three or more shapes evenly; the outermost two define the span."""
        return self._client.distribute.apply(self.id, ids, axis, spacing)

    def row(
        self,
        ids: Sequence[str],
        count: int,
        step_x: float,
        step_z: Optional[float] = None,
    ) -> PatternResult:
        """A row at a centre-to-centre pitch; ``count`` includes the original."""
        return self._client.patterns.row(self.id, ids, count, step_x, step_z)

    def ring(
        self,
        ids: Sequence[str],
        count: int,
        center: Tuple[float, float] = (0.0, 0.0),
        sweep_angle: Optional[float] = None,
        rotate_copies: Optional[bool] = None,
    ) -> PatternResult:
        """A ring about a point, which is how a bolt circle is made."""
        return self._client.patterns.ring(
            self.id, ids, count, center, sweep_angle, rotate_copies
        )

    def import_mesh(
        self,
        file_name: str,
        data: bytes,
        media_type: Optional[str] = None,
    ) -> MeshImportResult:
        """Adds the model a file describes, keeping the file with the project."""
        return self._client.imports.apply(self.id, file_name, data, media_type)

    def import_file(self, path: Union[str, "os.PathLike[str]"]) -> MeshImportResult:
        """The same import, reading the bytes and the name off a path."""
        return self._client.imports.file(self.id, path)
