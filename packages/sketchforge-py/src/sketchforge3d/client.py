"""
The client, and the project handle a macro actually works through.

Resources are plain objects hanging off the client, each owning one route. A
route added to the API later is a new class here and one more attribute; nothing
in the transport or the handle needs to know about it.
"""

from __future__ import annotations

from typing import Any, Dict, Iterable, List, Mapping, Optional, Sequence, Union

from ._http import DEFAULT_RETRY_ON_BUSY, DEFAULT_TIMEOUT_SECONDS, Transport
from .errors import SketchForgeApiError, SketchForgeTransportError
from .types import (
    MAX_SHAPES_PER_REQUEST,
    EdgeSummary,
    ProjectDetail,
    ProjectSummary,
    ShapePatch,
    ShapeRequest,
    ShapeSummary,
    ShapeWriteResult,
    TreatmentResult,
)


def chunk(items: Sequence[Any], size: int) -> List[List[Any]]:
    """Splits into runs of at most ``size``."""
    if size < 1:
        raise ValueError("A chunk size must be at least 1.")
    return [list(items[start : start + size]) for start in range(0, len(items), size)]


class Projects:
    def __init__(self, transport: Transport) -> None:
        self._transport = transport

    def list(self) -> List[ProjectSummary]:
        payload = self._transport.send("GET", "/projects") or {}
        return [ProjectSummary.from_payload(entry) for entry in payload.get("projects", [])]

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

    def create(self, project_id: str, shape: ShapeRequest) -> ShapeSummary:
        payload = self._transport.send(
            "POST", "/shapes", {"projectId": project_id}, dict(shape), retryable=True
        ) or {}
        created = payload.get("shapes") or []
        if not created:
            raise SketchForgeApiError("POST", "/shapes", 500, "the server returned no shape")
        return ShapeSummary.from_payload(created[0])

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


class SketchForgeClient:
    def __init__(
        self,
        base_url: str,
        token: str,
        timeout: float = DEFAULT_TIMEOUT_SECONDS,
        retry_on_busy: int = DEFAULT_RETRY_ON_BUSY,
        headers: Optional[Mapping[str, str]] = None,
        opener: Optional[Any] = None,
    ) -> None:
        self._transport = Transport(
            base_url=base_url,
            token=token,
            timeout=timeout,
            retry_on_busy=retry_on_busy,
            headers=headers,
            opener=opener,
        )
        self.projects = Projects(self._transport)
        self.shapes = Shapes(self._transport)
        self.edges = Edges(self._transport)
        self.treatments = Treatments(self._transport)

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

    def add(self, shape: ShapeRequest) -> ShapeSummary:
        return self._client.shapes.create(self.id, shape)

    def add_many(self, shapes: Iterable[ShapeRequest]) -> ShapeWriteResult:
        return self._client.shapes.create_many(self.id, shapes)

    def update(self, shape_id: str, changes: ShapePatch) -> ShapeSummary:
        return self._client.shapes.update(self.id, shape_id, changes)

    def remove(self, shape_id: str) -> bool:
        return self._client.shapes.delete(self.id, shape_id)

    def clear(self) -> int:
        return self._client.shapes.delete_all(self.id)

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
