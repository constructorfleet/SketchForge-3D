# sketchforge3d

A Python client for the [SketchForge REST API](../../docs/REST_API.md), and a runner for **macros**: short parameterised scripts that build a part.

```bash
pip install sketchforge3d
```

The install name and the import name are the same, and there are no runtime dependencies: the client speaks HTTP through `urllib` from the standard library, so it installs anywhere Python does and adds nothing to a macro author's lockfile.

The API is headless -- it reads and writes projects in server-side storage with no browser open -- so a macro is a build script for a design, the way a Makefile is for a binary.

## Connecting

```python
from sketchforge3d import SketchForgeClient, client_from_environment

client = SketchForgeClient(base_url="http://localhost:3000", token="...")
client = client_from_environment()  # SKETCHFORGE_API_TOKEN, SKETCHFORGE_URL

health = client.check()
if not health["ok"]:
    raise SystemExit(health["reason"])
```

Prefer the environment: the token is a password for every project on the server and does not belong in a script or in shell history. The server needs both `SKETCHFORGE_API_TOKEN` and `SKETCHFORGE_PROJECTS_DIR` set, or the API answers 404 and 503 respectively; `check()` says which.

## The client

```python
SketchForgeClient(base_url, token, timeout=60.0, retry_on_busy=4, headers=None, opener=None)

client.api_root -> str
client.check() -> dict
client.project(project_id) -> ProjectHandle

client.projects.list() -> list[ProjectSummary]
client.projects.list_page(limit=None, cursor=None) -> ListPage[ProjectSummary]
client.projects.get(project_id) -> ProjectDetail
client.projects.create(name) -> ProjectSummary
client.projects.delete(project_id) -> bool
client.projects.find_by_name(name) -> ProjectSummary | None

client.shapes.list(project_id) -> list[ShapeSummary]
client.shapes.list_page(project_id, limit=None, cursor=None) -> ListPage[ShapeSummary]
client.shapes.create(project_id, shape) -> ShapeSummary
client.shapes.create_many(project_id, shapes) -> ShapeWriteResult
client.shapes.update(project_id, shape_id, changes) -> ShapeSummary
client.shapes.delete(project_id, shape_id) -> bool
client.shapes.delete_all(project_id) -> int

client.edges.list(project_id, shape_id) -> list[EdgeSummary]
client.edges.filletable_indexes(project_id, shape_id) -> list[int]

client.treatments.apply(project_id, shape_id, kind, amount, angle=None, edges=None) -> TreatmentResult
client.treatments.fillet(project_id, shape_id, radius, edges=None) -> TreatmentResult
client.treatments.chamfer(project_id, shape_id, distance, angle=None, edges=None) -> TreatmentResult
client.draft_prisms.apply(project_id, shape_id, angle) -> TreatmentResult

client.faces.list(project_id, shape_id, topology=None) -> list[FaceSummary]
client.faces.facing(project_id, shape_id, direction) -> list[int]

client.measurements.list(project_id, shape_id) -> list[MeasurementSummary]
client.measurements.with_radius(project_id, shape_id) -> list[MeasurementSummary]
client.measurements.between(project_id, from_, to) -> MeasurementPair
client.properties.get(project_id, shape_id) -> ShapeProperties
client.interference.check(project_id, ids=None, clearance=None) -> InterferenceReport
client.mirrors.bake(project_id, ids, axis) -> BakedMirrorResult

client.shell.apply(project_id, shape_id, thickness, open_faces=None) -> ShellResult
client.shell.hollow(project_id, shape_id, thickness) -> ShellResult
client.shell.tray(project_id, shape_id, thickness, open_faces=None) -> ShellResult

client.booleans.cut(project_id, solid_ids, hole_ids) -> BooleanCutResult
client.groups.group(project_id, ids) -> ShapeOperationResult
client.groups.ungroup(project_id, shape_id) -> ShapeCollectionResult
client.parts.separate(project_id, shape_id) -> ShapeCollectionResult

client.align.apply(project_id, ids, axis, target, anchor_id=None) -> AlignResult
client.align.tops(project_id, ids, anchor_id=None) | bottoms(...) | centers(project_id, ids, axis, anchor_id=None)

client.distribute.apply(project_id, ids, axis=None, spacing=None) -> DistributeResult
client.distribute.gaps(project_id, ids, axis=None) | pitch(project_id, ids, axis=None)

client.patterns.apply(project_id, ids, kind=None, count=None, step_x=None, step_z=None, center_x=None, center_z=None, sweep_angle=None, rotate_copies=None) -> PatternResult
client.patterns.row(project_id, ids, count, step_x, step_z=None) -> PatternResult
client.patterns.ring(project_id, ids, count, center=(0, 0), sweep_angle=None, rotate_copies=None) -> PatternResult

client.imports.apply(project_id, file_name, data, media_type=None) -> MeshImportResult
client.imports.file(project_id, path) -> MeshImportResult

client.explosions.explode(project_id, shape_id) -> ShapeCollectionResult
client.thickness.estimate(project_id, shape_id) -> WallThicknessEstimate

client.exports.export(project_id, format, shape_ids=None, name=None, view=None, section=None) -> ExportResult
client.exports.file(project_id, format, path, shape_ids=None, name=None, view=None, section=None) -> ExportResult
```

For an SVG or DXF section drawing, set `section={"plane": "xy", "offset": 3}` instead
of `view`. The supported planes are `xy`, `xz`, and `yz` in drawing coordinates;
the plane must intersect the selected shapes.

Use `client.faces.list(project_id, shape_id, topology="exact")` or
`project.faces(shape_id, topology="exact")` to list analytic faces, including
plain revolves. Omitting `topology` keeps the server's default mesh listing;
`"mesh"` selects that listing explicitly.

`project.explode(shape_id)` replaces an imported STEP assembly with its component
solids and returns their summaries and the new project revision.
`project.estimate_wall_thickness(shape_id)` returns a frozen `WallThicknessEstimate`
with `minimum` (millimetres, or `None` when no opposing surface was found),
`unit`, `method`, `samples_per_face`, and `faces_checked`. This sampled estimate
is not a certified minimum wall thickness.

```python
section = client.exports.export(
    project_id, format="dxf", section={"plane": "xy", "offset": 3}
)
```

DXF exports require a section plane; they do not support projection `view`.

Baked mirror reflects exact parameter-built solids across their selected bounds midpoint and stores exact BREP. Imported meshes, groups, and previously treated shapes are refused rather than silently tessellated.

Shape requests remain ordinary mappings, so existing macros can keep passing
plain dictionaries and can include fields added by newer server versions. For
editor completion and static checking, the package also exports opt-in typed
request definitions for every parameter-created shape kind:

```python
from sketchforge3d import BoxShapeRequest, GearShapeRequest

plate: BoxShapeRequest = {"kind": "box", "name": "Plate", "width": 60, "depth": 40, "height": 8}
gear: GearShapeRequest = {"kind": "gear", "teeth": 24, "toothSize": 1.5}
project.add(plate)
project.add(gear)
```

The available per-kind types are `BoxShapeRequest`, `CubeShapeRequest`,
`CylinderShapeRequest`, `ConeShapeRequest`, `SphereShapeRequest`,
`HalfSphereShapeRequest`, `TorusShapeRequest`, `TubeShapeRequest`,
`RingShapeRequest`, `PolygonShapeRequest`, `PyramidShapeRequest`,
`RoofShapeRequest`, `RoundRoofShapeRequest`, `WedgeShapeRequest`,
`IcosahedronShapeRequest`, `TextShapeRequest`, `LoftShapeRequest`,
`GearShapeRequest`, `RevolveShapeRequest`, and `ThreadShapeRequest`.
`ShapeSpec` is their union, and `RequestableShapeKind` names the supported kind
values. These are static typing aids; they do not validate requests at runtime.
`SketchSweepShapeRequest` is also in `ShapeSpec`; its `profile` contains closed
section path(s), one open spine, and optional explicit workplane frames. The
server-built result keeps the original sketch in `ShapeSummary.sketch_profile`.
`SketchSweepShapeRequest` is also in `ShapeSpec`; its `profile` contains closed
section path(s), one open spine, and optional explicit workplane frames. The
server-built result keeps the original sketch in `ShapeSummary.sketch_profile`.

A `ProjectHandle` is the same surface with the project id bound, which is what a macro works through:

```python
project.get() | delete() | list_shapes() | add(shape) | add_many(shapes) | update(id, changes)
project.remove(id) | clear() | edges(id) | filletable_edges(id)
project.fillet(id, radius, edges=None) | chamfer(id, distance, angle=None, edges=None)
project.faces(id, topology=None) | faces_facing(id, direction)
project.measurements(id) | measurements_with_radius(id) | measure_between(from_, to) | properties_of(id) | check_interference(ids=None, clearance=None)
project.shell(id, thickness, open_faces=None) | hollow(id, thickness) | tray(id, thickness, open_faces=None)
project.draft_prism(id, angle)
project.cut(solid_ids, hole_ids) | group(ids) | ungroup(id) | separate(id) | explode(id)
project.estimate_wall_thickness(id)
project.align(ids, axis, target, anchor_id=None) | align_tops(ids, anchor_id=None) | mirror_baked(ids, axis)
project.distribute(ids, axis=None, spacing=None) | row(ids, count, step_x, step_z=None)
project.ring(ids, count, center=(0, 0), sweep_angle=None, rotate_copies=None)
project.import_mesh(file_name, data) | import_file(path)
project.export(format, shape_ids=None, name=None, view=None, section=None)
project.export_file(format, path, shape_ids=None, name=None, view=None, section=None)
```

`import_file` uploads multipart form data, avoiding base64 expansion; `import_mesh`
continues to accept bytes and uses the JSON API. Exports support `stl`, `obj`,
`3mf`, `step`, `skf`, `zip`, `svg`, and `dxf`. An `svg` is a hidden-line drawing of the
exact geometry; `view` picks `multiview` (the default front, top, right and iso
grid) or any one of `EXPORT_VIEWS`, and the server refuses `view` on any other
format. `export` returns artifact metadata and bytes;
`export_file` streams the artifact to a local path and returns the same metadata
with `data=b""`, so large downloads do not also stay resident in Python memory.
The download response carries all result metadata, including STEP's skipped
shapes, in a response header; very large skip lists may exceed proxy header
limits. STEP reports the exact solids it exported and shapes it skipped.

Requests are plain dicts, because the server takes a bag of parameters; responses are frozen dataclasses with snake_case fields, so `shape.rotation_x` is checked and a typo is an error rather than a `None`. A field this version does not know about is kept in `shape.extra` rather than dropped.

```python
project.add_many([
    {"kind": "box", "name": "Plate", "width": 120, "depth": 40, "height": 6},
    {"kind": "cylinder", "width": 8, "height": 12, "sides": 6, "x": -40, "elevation": -1, "hole": True},
    {"kind": "thread", "size": "M8", "length": 10, "hole": True, "x": 40},
    {"kind": "revolve", "profile": [[8, 0], [10, 0], [10, 2], [8, 2]], "pitch": 6, "turns": 6},
])
```

`create_many` is one write of the project package per request and splits lists longer than the server's 200-shape limit -- which also means a longer list is no longer atomic.

To edit a retained sweep, use the profile returned as `shape.sketch_profile`; `as_patch` carries it back under the API's `sketchProfile` wire name:

```python
sweep = client.shapes.create(project_id, {"kind": "sketchSweep", "profile": profile})
assert sweep.sketch_profile is not None
edited = {
    **sweep.sketch_profile,
    "points": [
        {**point, "x": point["x"] * 1.1} if point.get("sweepRole") == "section" else point
        for point in sweep.sketch_profile["points"]
    ],
}
client.shapes.update(project_id, sweep.id, sweep.as_patch(sketchProfile=edited))
```

One face draft can be retained on a sketch extrusion and replayed after its source profile changes. Use a stable face ID from the shape's `face_ids`; the draft value accepts a signed local pull axis and an angle in degrees. The server only replays the selected face when its planar normal maps uniquely after the edit. `ShapeSummary.face_draft` is retained by `as_patch`, and `faceDraft=None` clears the operation:

```python
client.shapes.update(project_id, shape.sketch_source_id, {
    "faceDraft": {"sourceFaceId": shape.face_ids[1], "angle": 5, "pullDirection": "z"},
})
```

Face drafts cannot yet be combined with prism drafts or edge treatments. Missing or ambiguous face matches and ineffective dependent booleans leave the project unchanged.

Failures are `SketchForgeApiError` (`status`, `detail`, plus `looks_disabled`, `needs_storage`, `is_project_busy`, and `is_limit_exceeded`) or `SketchForgeTransportError`, both subclasses of `SketchForgeError`. `is_limit_exceeded` recognises `413 limit_exceeded` and the legacy `too_many_shapes` code. A write that lost the project's lock is retried; a *locked shape*, which answers 409 for an unrelated reason, is not.

`sketchforge3d.layout` has the arithmetic a parameterised part repeats: `row`, `grid`, `ring`, `centered_offsets`, `angle_of`, `mm`.

## Macros

A macro is a file that defines `MACRO` and builds something when it is handed a connected project:

```python
# macros/bolt_plate.py
from sketchforge3d import MacroContext, define_macro


def build(context: MacroContext) -> dict:
    params, layout = context.params, context.layout
    context.log(f"{params['holes']} {params['size']} holes")
    context.project.add_many(
        [{"kind": "box", "name": "Plate", "width": 200, "depth": 40, "height": params["thickness"]}]
        + [
            {
                "kind": "thread",
                "name": f"hole {index}",
                "size": params["size"],
                "length": params["thickness"] + 2,
                "hole": True,
                "x": at.x,
                "z": at.z,
                "elevation": -1,
            }
            for index, at in enumerate(layout.row(int(params["holes"]), float(params["spacing"])), start=1)
        ]
    )
    return {"holes": params["holes"]}


MACRO = define_macro(
    name="Bolt plate",
    project=("replace", "Bolt plate"),
    params={"holes": 5, "spacing": 25.0, "size": "M8", "thickness": 8.0},
    run=build,
)
```

```bash
SKETCHFORGE_API_TOKEN=... python -m sketchforge3d.macro macros/bolt_plate.py --holes=7 --spacing=30
```

`python -m sketchforge3d`, and the `sketchforge-macro` console script, run the same thing. The context carries everything the macro needs -- `client`, `project`, `params`, `layout`, `log` -- so a macro file imports only `define_macro`.

Inspect a macro's declared parameters and project mode without running its code:

```bash
python -m sketchforge3d.macro macros/bolt_plate.py --describe --json
```

The CLI takes a file path, and the MCP runner only runs reviewed files from
`SKETCHFORGE_MACRO_DIR`. A Python program or notebook can define and run a
macro directly without loading a separate macro file:

```python
from sketchforge3d import client_from_environment, define_macro, run_macro


def build(context):
    context.project.add({"kind": "box", "width": 60, "depth": 40, "height": 8})


macro = define_macro("Bracket", run=build, project="fresh")
report = run_macro(client_from_environment(), macro)
print(report.project_id)
```

### Project modes, and why there is no default

The second run is what makes a macro useful or dangerous. A script that appends to a project it found doubles the part every time, and nobody notices until they open the project. So the mode is declared and the runner, not the macro body, acts on it:

| `project` | What the runner does first | Use it for |
| --- | --- | --- |
| `"fresh"` | Creates a new project, name stamped with the time | Something you generate several of to compare |
| `("replace", name)` | Finds that project and **empties** it, or creates it | A part you iterate on; re-running is idempotent |
| `("reuse", name)` | Finds or creates it, and leaves the contents alone | Adding a feature to whatever is there |
| `"target"` | Requires `SKETCHFORGE_PROJECT_ID` or `--project`, touches nothing else | Operating on a project someone else named |

A module with a bare `run(context)` function instead of a `MACRO` runs in a `fresh` project, because that is the only mode that is safe to assume.

### Parameters

`params` is both the defaults and the schema. An override is coerced to the type of its default -- an `int` default refuses `4.5`, a `float` default takes it -- and a name the macro does not declare is refused, so `--hoels=7` is an error rather than a silently ignored typo. Parameters are resolved before the project is created, so a bad one costs nothing.

## Examples

`examples/` holds the four worked macros, which double as the integration tests:

| Macro | Builds |
| --- | --- |
| `bolt_plate.py` | A plate sized around a computed row of tapped holes |
| `bolt_circle.py` | A flange with N tapped holes on a ring of radius R |
| `filleted_box.py` | A box from three numbers, with every roundable edge filleted on the server |
| `face_colors.py` | A box coloured by face, then filleted, reporting which colours survived |

A face colour is keyed by the face's `id` from `project.faces(...)`, not by its
position in the listing: the kernel reorders faces after any operation, so an
index is only true until the next one. `faces.ids_facing(...)` gives the ids of
the faces pointing a given way, which is the form to persist; `faces.facing(...)`
still answers with indexes for choosing a face right now. A `ShapeSummary`
carries both halves back as `face_ids` and `face_colors`, and a project saved
before stable identity keeps its numeric keys, which the server still accepts.

Tapped holes are `{"kind": "thread", "hole": True}`: the form is cut wider by a clearance and the shape is marked as a hole. Grouping the hole with the plate cuts it; `project.group([...])` exposes that operation, and `project.cut(...)` supports explicit solid and cutter lists. `project.separate(id)` splits disconnected bodies and `project.ungroup(id)` restores a group's children.

## Development

Tests are `unittest` from the standard library, so there is nothing to install:

```bash
PYTHONPATH=src:tests python3 -m unittest discover -s tests -t tests        # unit
PYTHONPATH=src python3 -m unittest discover -s tests/integration -t tests/integration  # needs a live server
```

From the repository root those are `npm run client:test:py` and `npm run client:test:py:integration`. The integration tests need a real server:

```bash
SKETCHFORGE_PROJECTS_DIR=$(mktemp -d) SKETCHFORGE_API_TOKEN=test-token \
  npx next dev apps/web -p 3100 &
export SKETCHFORGE_API_TOKEN=test-token SKETCHFORGE_URL=http://127.0.0.1:3100
npm run client:test:py:integration
```

## Publishing

See [docs/PUBLISHING_CLIENTS.md](../../docs/PUBLISHING_CLIENTS.md) for the trusted-publisher settings PyPI needs before the release workflow can publish this package.
