# REST API

A scripting surface for SketchForge projects (upstream issue [#55](https://github.com/Formsmith746/SketchForge-3D/issues/55)). Shapes are described as data, so an LLM or a build script can generate a parameterised design -- a plate with a computed row of holes, a family of brackets at four sizes -- without driving the editor.

It is **headless**: it reads and writes the projects that server-side storage holds, with no browser open anywhere. A dashboard that has the project open picks the change up on its next load, because every write advances the project's revision.

## Client libraries

Two clients wrap everything below, with the macro runner that makes a parameterised part a script you can re-run:

| Library | Install | Docs |
| --- | --- | --- |
| TypeScript | `npm install @constructorfleet/sketchforge3d` | [packages/sketchforge-client](../packages/sketchforge-client/README.md) |
| Python | `pip install sketchforge3d` | [packages/sketchforge-py](../packages/sketchforge-py/README.md) |

Both are thin: everything here is reachable through them, and nothing is only reachable through them. Reach for `curl` for one request and a client for a part.

## Turning it on

Both of these are required:

| Variable | Why |
| --- | --- |
| `SKETCHFORGE_API_TOKEN` | The API is off without it. With no token set, every route answers `404`. |
| `SKETCHFORGE_PROJECTS_DIR` | Where projects live. See "Server-Side Project Storage" in the README. Without it the API answers `503`. |

```bash
docker run -d --name sketchforge --restart unless-stopped \
  -p 3000:3000 \
  -e SKETCHFORGE_PROJECTS_DIR=/data/my-projects \
  -e SKETCHFORGE_API_TOKEN="$(openssl rand -hex 32)" \
  -v sketchforge-projects:/data/my-projects \
  ghcr.io/formsmith746/sketchforge-3d:latest
```

Send the token as a bearer header (`Authorization: Bearer <token>`) or as `X-SketchForge-Token`. The API has no user model: anyone holding the token can read, change, and delete every project. Treat it as a password and do not expose the port to the internet without TLS in front of it.

## Endpoints

All paths are under `/api/v1`. Bodies and responses are JSON; errors are `{ "error": "...", "code": "..." }` with a meaningful status. The sentence is for whoever is reading; the code is for whatever is deciding what to do next (see **Errors**, below).

| Method | Path | Does |
| --- | --- | --- |
| `GET` | `/projects` | Lists projects: id, name, shape count, revision. |
| `GET` | `/projects?projectId=` | One project with its shapes and settings. |
| `POST` | `/projects` | Creates an empty project. Body: `{ "name": "Bracket" }`. |
| `DELETE` | `/projects?projectId=` | Deletes the project and its geometry. |
| `GET` | `/shapes?projectId=` | The project's shapes. |
| `POST` | `/shapes?projectId=` | Adds one shape, or a batch via `{ "shapes": [...] }` (max 200). |
| `PATCH` | `/shapes?projectId=&shapeId=` | Changes the fields you send and leaves the rest; refuses the ones that kind cannot take. |
| `DELETE` | `/shapes?projectId=&shapeId=` | Removes one shape. |
| `POST` | `/booleans?projectId=` | Subtracts shapes from shapes. Body: `{ "solidIds": [...], "holeIds": [...] }`. |
| `POST` | `/groups?projectId=` | Groups shapes into one. Body: `{ "ids": [...] }`. |
| `DELETE` | `/groups?projectId=&shapeId=` | Takes a group apart. |
| `POST` | `/parts?projectId=&shapeId=` | Splits a shape into its disconnected bodies. |
| `GET` | `/faces?projectId=&shapeId=` | The shape's faces: index, area, surface type, centroid, normal, direction. |
| `POST` | `/shell?projectId=&shapeId=` | Hollows the shape out to a wall, optionally leaving faces open. |

The project and shape are named in the query string rather than the path. That is not a style choice: a dynamic path segment makes the static-export build fail outright, because an exported build has no server to resolve one against. The dashboard's own routes are shaped this way for the same reason.

## Describing a shape

```json
{ "kind": "cylinder", "width": 8, "height": 30, "sides": 6, "x": 12, "name": "Post" }
```

`kind` is one of `box`, `cube`, `cylinder`, `cone`, `sphere`, `halfSphere`, `torus`, `tube`, `ring`, `polygon`, `pyramid`, `roof`, `roundRoof`, `wedge`, `icosahedron`, `text`, `loft`, `gear`, plus `revolve` and `thread` (below). A `cube` is a box whose sides match, and `size` stands in for `width`, `depth`, and `height` together. Only `mesh`, `sketch`, and `scribble` are left out: those need geometry or a drawn profile rather than numbers.

Common fields: `name`, `color`, `x`, `z`, `elevation`, `width`, `depth`, `height`, `rotation`, `rotationX`, `rotationZ`, `hole`.

Per kind:

| Fields | For |
| --- | --- |
| `sides` | `cylinder` (6 gives a hex prism), `pyramid` (4 unless you say otherwise), `cone`, `roundRoof` |
| `bevel` | `tube` and `ring` -- the wall thickness, measured inwards |
| `topRadius`, `baseRadius` | `cone` |
| `steps` | `sphere`, `halfSphere` |
| `text`, `font`, `bevel`, `segments` | `text` |
| `teeth`, `toothSize`, `toothWidth`, `centerHoleSize`, `gearType`, `helixAngle` | `gear`. `gearType` is `spur`, `helical` or `bevel`; `helixAngle` only matters for a helical one. `teeth` is 6-64. |
| `loftBottomShape`, `loftTopShape`, `loftTopWidth`, `loftTopDepth`, `loftBottomRotation`, `loftTopRotation`, `loftSegments`, `loftLayers` | `loft`. The two shapes are `Oval`, `Rectangle`, `Triangle`, `Pentagon` or `Hexagon` -- capitalised, as the editor names them; anything else quietly takes the default. |
| `taperTopWidth`, `taperTopDepth`, `taperBottomWidth`, `taperBottomDepth` | every kind but `gear` -- the footprint at each end of the extrusion, which need not match `width` and `depth` |

Dimensions are clamped to 0.01-10000 mm. Anything missing takes the same default the editor would have used, so a request need only carry what it cares about.

## Reading a shape back

Everything above can be read as well as set, which is what makes **read a shape, change a number, send it back** actually work. A summary carries the shape's placement and size, the parameters its kind is built from, and two fields that say what it is:

```json
{
  "id": "shape-7f2c", "name": "M8", "kind": "mesh",
  "requestKind": "revolve", "sketchOperation": "revolve",
  "color": "#78b96b", "hole": false, "locked": false, "hidden": false,
  "x": 0, "z": 0, "elevation": 0, "width": 8, "depth": 8, "height": 20,
  "rotation": 0, "rotationX": 0, "rotationZ": 0,
  "revolve": { "startAngle": 0, "sweepAngle": 360, "sides": 64, "quality": 6, "pitch": 1.25, "turns": 16, "coreRadius": 3.19 },
  "profile": [[2.43, 0], [4, 0.625], [2.43, 1.25]]
}
```

`kind` is what the project stores, which is what the editor shows: a `cube` is a box whose sides match, and a revolve, a boolean cut and an imported STL are all `mesh`. That meaning is unchanged, because every existing caller already reads it that way.

`requestKind` is the other half: the kind a `POST` would need to build this shape again. A `cube` reads back as `requestKind: "box"`, and a thread or a revolve as `requestKind: "revolve"` -- a thread is a revolve with the outline filled in, so a revolve is what reproduces either. It is **absent** for a shape no request can reproduce: a boolean cut, a group, an imported mesh, a drawn sketch. That absence is how a client tells a thread from an STL, which by `kind` alone it could not.

`sketchOperation` names the operation the geometry came out of, for the shapes that have one -- `revolve` for these.

A revolve also reports `revolve` (the sweep: its pitch, turns, sweep angle, start angle, facets per turn, sampling quality, and the radius of the core it is fused to) and `profile` (the outline it ran round, as `[x, z]` pairs with distances written positive, the way a request writes them). `profile` is omitted when the outline was drawn in the editor rather than described: a drawn profile can be several paths with curve handles, which no flat list of pairs describes, and guessing one would be worse than saying nothing.

## Changing a shape

`PATCH` takes everything a summary reports, including a shape's own summary sent straight back with one number changed. Alongside placement, size and the `hole`, `locked` and `hidden` flags, it takes:

- every parameter the shape's kind is built from, as listed above;
- for a revolve or a thread, the sweep: `pitch`, `turns`, `startAngle`, `sweepAngle`, `sides`, `quality` and `coreRadius`, either at the top level or nested under `revolve`, and a `profile` to replace the outline;
- `id`, `kind`, `requestKind`, `sketchOperation` and `groupedCount`, which are accepted and ignored -- they describe the shape rather than set anything on it, so sending a whole summary back is not an error.

Anything else is **refused**, naming what it could not apply:

```json
{ "error": "A shape of kind \"box\" cannot take: sides.", "code": "unapplicable_fields", "fields": ["sides"] }
```

That covers a parameter belonging to another kind (`sides` on a box), a sweep setting on a shape with no sweep (`pitch` on a cylinder), and a field this version has never heard of (`sids`). None of it is applied: the request is refused whole, so a typo cannot half-move a shape. Before this, all of it answered `200` having changed nothing, which is the one answer a script cannot tell from success.

**Changing a sweep rebuilds the geometry.** A revolve's pitch, turns and outline *are* its mesh, so changing one sweeps it again on the server -- the same manifold build `POST` uses. The shape keeps its id, name, colour, placement and flags, and keeps any scale it had been resized to, so changing a thread's pitch does not silently resize it. Its height will change, because four turns at a coarser pitch is a taller bolt.

A locked shape answers `409` with `code: "shape_locked"`; send `locked: false` to unlock it.

**A sketch extrusion is not a kind you can ask for here**: its profile is drawn, not described. Operations whose geometry comes out of the CAD kernel -- fillets, chamfers, and boolean cuts -- have endpoints of their own, below; `POST /shapes` builds only what can be built from parameters alone, and answers `422` naming the kinds it can build rather than quietly substituting something else.

## Errors

Every error carries a `code` beside its sentence, because the status alone is ambiguous in both directions a client cares about. `404` is a missing project, a missing shape, *or* an API with no token set; `409` is both a project someone else is writing -- retry -- and a locked shape -- do not. Decide on the code; the sentence is for a human reading a log.

| Code | Status | Means |
| --- | --- | --- |
| `api_disabled` | 404 | No `SKETCHFORGE_API_TOKEN`, so there is no API at all. |
| `unauthorized` | 401 | The bearer token is missing or wrong. |
| `storage_unconfigured` | 503 | A token but no `SKETCHFORGE_PROJECTS_DIR`: nowhere to store a project. |
| `invalid_project_id` / `invalid_shape_id` | 400 | The id is missing or not a safe id. |
| `invalid_body` | 400 | The body was not a JSON object. |
| `invalid_request` | 400 / 422 | A field is missing, malformed, or asks for something this shape has nothing to do. |
| `project_not_found` / `shape_not_found` | 404 | No such project, or no such shape in it. |
| `project_exists` | 409 | A project with that id is already there. |
| `project_busy` | 409 | Another write holds the project's lock. **Retry.** |
| `shape_locked` | 409 | The shape is locked. Unlock it; retrying will not help. |
| `unsupported_kind` | 422 | `POST /shapes` cannot build that kind; the message lists the ones it can. |
| `unapplicable_fields` | 422 | A change named fields the shape cannot take. `fields` lists them. |
| `too_many_shapes` | 413 | More than 200 shapes in one `POST`. |
| `geometry_failed` | 422 | The sweep or the boolean could not be built. |
| `cad_failed` | 4xx / 500 | OCCT refused, or fell over. |

A server from before codes sends only `error`, so a client should keep whatever prose match it had as a fallback. Both bundled client libraries do exactly that.

## Revolves and threads

A revolve is described by an outline rather than by dimensions, so it has its own two kinds. This is the one shape nobody wants to place by hand: a thread's profile is three points and its pitch is a number from a table.

```bash
# A standard size: "M8" carries its own pitch, and length beats counting turns
curl -X POST "$HOST/shapes?projectId=$PROJECT" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"kind":"thread","size":"M8","length":20}'

# The tapped hole for that bolt: cut wider so it fits, and marked as a hole
curl -X POST "$HOST/shapes?projectId=$PROJECT" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"kind":"thread","size":"M8","length":10,"hole":true}'

# A spring of square wire: any closed outline, swept along a helix
curl -X POST "$HOST/shapes?projectId=$PROJECT" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"kind":"revolve","profile":[[8,0],[10,0],[10,2],[8,2]],"pitch":6,"turns":6}'

# No pitch: a plain ring, revolved once
curl -X POST "$HOST/shapes?projectId=$PROJECT" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"kind":"revolve","profile":[[4,0],[6,0],[6,3],[4,3]]}'
```

| Field | Means |
| --- | --- |
| `profile` | The closed outline to revolve, as `[x, z]` pairs. `x` is the distance from the axis, `z` runs along it. A triangle makes a thread, a rectangle a tube or a coil of square wire, a many-sided polygon a round spring. Distances may be written positive. |
| `pitch` | Axial rise per full turn, in mm. `0` is a plain revolve. **Negative is a left-hand thread.** |
| `turns` | How many full turns to sweep (0.1–20). |
| `startAngle` | Rotation the sweep starts at. |
| `sweepAngle` | How far round to revolve when there is no pitch (±360). |
| `size` | `thread` only: a catalog designation that carries its own pitch. Metric coarse `M2`–`M20`, imperial UNC `#4-40`–`1/2-13`. Default `M8`. An unknown size is refused with the list of known ones. |
| `diameter` | `thread` only: outside diameter, for a size the catalog does not list. With `pitch`, it gives the ISO 60-degree profile. |
| `length` | `thread` only: how long the thread should be, instead of counting turns. |
| `hole` | `thread` only: cut the form wider by a clearance so a bolt of that size fits, and mark the shape as a hole -- so grouping it with a solid taps that solid. |
| `clearance` | `thread` with `hole`: how much wider to cut, per side (default 0.2mm, a starting point for FDM). |
| `core` | `thread` only: `false` leaves the bare helix with no shank or drilled hole. On by default, because a thread without its core is a floating ribbon rather than a bolt or a tapped hole. |

A thread comes with its core: a bolt is the thread standing on its shank, and a tapped hole is the thread plus the hole it is cut into, so neither is useful as a bare helix. The core's radius is the thread's root, is fused into one solid, and appears as **Core radius** in the object panel -- set it to 0 there, or pass `core: false`, for the ribbon on its own (a spring, say).

A `thread` is a `revolve` with the outline filled in; pass your own `profile` to override it. Either way the result is a mesh that keeps its profile and settings, so **its pitch and turns stay editable afterwards** -- in the editor's inspector, and over this API: a thread reads back with its sweep under `revolve`, and a `PATCH` changing the pitch sweeps it again.

Threads and springs are built by manifold rather than OCCT, so unlike a fillet they need no exact B-Rep -- but for the same reason the fillet endpoints will not treat one: a swept mesh has no analytic surface to blend. Fillet the profile instead, before sweeping it.

## Fillets and chamfers, on the server

The editor rounds and cuts edges in a browser worker: every client downloads a 22 MB CAD kernel and runs the solid modelling on whatever hardware it has. These two endpoints do it on the server instead, which is also the only way a script can ask for geometry that cannot be described as parameters.

| Method | Path | Does |
| --- | --- | --- |
| `GET` | `/edges?projectId=&shapeId=` | The shape's edges: index, length, curve type, midpoint. |
| `POST` | `/treatments?projectId=&shapeId=` | Applies a fillet or chamfer. |

```bash
# Every edge
curl -X POST "$HOST/treatments?projectId=$PROJECT&shapeId=$SHAPE" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"kind":"fillet","amount":3}'

# Named edges, by the index the edges endpoint gave them
curl -X POST "$HOST/treatments?projectId=$PROJECT&shapeId=$SHAPE" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"kind":"chamfer","amount":2,"angle":30,"edges":[0,1,2,3]}'
```

`kind` is `fillet` or `chamfer`; `amount` is the radius or distance in mm; `angle` applies to chamfers (45 degrees, the default, is symmetric); `edges` is a list of indexes, or omitted for all of them.

The treated shape keeps its place and its size, and stores the exact geometry alongside the mesh -- so STEP export writes true surfaces rather than triangles, and a further treatment builds on the real solid.

### What it can work from

Each shape is rebuilt as true geometry from what the project stores, rather than from a mesh of it. A round cylinder is a cylinder -- three faces, one of them a real cylindrical surface -- so a fillet lands on the surface rather than on a 96-sided approximation of it. These kinds are built exactly:

| Kind | Built as |
| --- | --- |
| `box` | A box; a tapered one lofts between its two end rectangles. |
| `cylinder` | A cylinder. A deliberately faceted one (`sides` under 96) is the prism it is; one wider than it is deep is a true ellipse; a tapered one is a cone, or a lofted prism when faceted. |
| `cone` | A cone, honouring its top radius. |
| `sphere` | An ellipsoid of its three dimensions. |
| `halfSphere` | The same, with its lower half cut away. |
| `loft` | A loft between its two profiles, each at its own size and rotation. |
| `polygon` | A six-sided prism. |
| `tube`, `ring` | A cylinder with its bore cut out, at the wall thickness the shape carries. |
| `roof` | A triangular prism with its ridge over the middle. |
| `wedge` | The same, with the ridge over one side so one face is vertical. |
| `roundRoof` | Half an ellipse, extruded. |
| `pyramid` | A base and one triangle per side; four sides unless the shape says otherwise. |
| `torus` | A ring sized the way the editor sizes one, and centred on the workplane rather than sitting on it. |

It also works from **exact geometry a shape already carries** -- anything previously treated, or a STEP import -- and from **an imported model's triangles**, sewn back into a solid.

Other kinds answer `422` naming the kind: `text`, `gear`, `sketch`, `scribble`, and `icosahedron`. Their geometry is font- or tessellation-derived, and approximating it would quietly give you a different part. Treat those in the editor.

### Which edges can be rounded

Each entry in the edge listing carries `filletable`. An edge between two faces can be rounded; a **seam** -- where one curved surface meets itself, as along a cylinder's side or around a torus -- has no two faces to blend, and OCCT refuses it.

A request for every edge rounds every edge that can be. Naming a seam explicitly is an error rather than a silent skip, so a script cannot think it did something it did not. A shape with no roundable edges at all -- a torus, a sphere -- says so, instead of blaming the radius.

A shape's rotation is built into the geometry, so a turned shape comes back turned.

### When it refuses

A radius or distance that does not fit the geometry answers `422` ("too large for this shape's edges"). This is the common mistake: a 5 mm fillet on a 1 mm plate has nowhere to go. OCCT reports it in milliseconds here rather than grinding, and the project is left exactly as it was.

Stacking treatments works, but OCCT will refuse a second one on edges immediately adjacent to the first -- the surfaces there are already tangent. Treat the edges you want in one request where you can.

## Hollowing a solid: shells and trays

A solid box printed at 20mm cube costs four times the filament of the same box with a 2mm wall, and the same box with its top face left open is a tray. This is the one operation a printed part wants most often, and `POST /shell` is it: OCCT offsets every face inwards by the thickness you give and takes the result away from the original, leaving a wall.

| Method | Path | Does |
| --- | --- | --- |
| `GET` | `/faces?projectId=&shapeId=` | The shape's faces: index, area, surface type, centroid, outward normal, direction. |
| `POST` | `/shell?projectId=&shapeId=` | Hollows the shape out to a wall of `thickness`, leaving `openFaces` off. |

```bash
# A sealed hollow: a wall all the way round, with the void closed in
curl -X POST "$HOST/shell?projectId=$PROJECT&shapeId=$SHAPE" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"thickness":2}'

# A tray: the same wall, with the lid left off
curl -X POST "$HOST/shell?projectId=$PROJECT&shapeId=$SHAPE" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"thickness":2,"openFaces":["top"]}'

# A sleeve: open at both ends, named by index from the face listing
curl -X POST "$HOST/shell?projectId=$PROJECT&shapeId=$SHAPE" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"thickness":1.6,"openFaces":[2,3]}'
```

`thickness` is the wall in mm, measured **inwards** from the surface, so the part keeps its outside dimensions: a 20mm cube shelled to 2mm is still 20mm across and weighs 20³ − 16³ = 3904mm³ instead of 8000.

`openFaces` is the faces to leave off, and is omitted or empty for a sealed hollow. A single entry need not be a list: `"openFaces": "top"` is the same request as `["top"]`.

The result keeps its place and its size, and stores the exact geometry alongside the mesh -- so a hollowed part exports to STEP as true surfaces, and a fillet afterwards builds on the real solid rather than on triangles.

### Naming the faces to leave open

Two ways, and they can be mixed in one request.

**By direction.** `top`, `bottom`, `left`, `right`, `front`, `back` -- in the shape's own frame, with `top` towards +Y and `front` towards the viewer, which is the frame the editor's own alignment buttons use. Nobody should have to list a box's faces to find out which one is the lid.

A direction means the **outermost flat face pointing that way**, and only that one. This matters on a part that is already hollow: the floor of its cavity points up as surely as its lid does, and opening the floor instead of the lid looks exactly like nothing happening. A shape with no flat face pointing that way -- a sphere, a torus, a pointed cone, a pyramid, a roof -- answers `422` saying so, rather than opening whichever face came closest. Those kinds can still be hollowed **sealed**; they just have no lid to take off.

**By index**, from `GET /faces`, which is the only way to name a face no direction describes -- one wall of a hexagonal pot, say:

```json
{
  "faces": [
    { "index": 3, "surfaceType": "plane", "area": 400,
      "centroid": { "x": 0, "y": 20, "z": 0 },
      "normal": { "x": 0, "y": 1, "z": 0 }, "facing": "top" }
  ]
}
```

`facing` is `null` for every face a direction does not name, including a curved one and an inner one; `normal` points out of the solid, and is `null` for a surface that cannot report one. The indexes are the ones `POST /shell` refers to, built from the same geometry, so a listing and a request taken together are consistent -- but a shape **changes shape** when it is hollowed, so re-list the faces of a result before naming indexes on it.

### What it can work from

The same exact builders the fillet endpoint uses, so the kinds listed under "What it can work from" above are the kinds a hollow can start from -- with one further limit, which is OCCT's rather than this app's.

| Hollows | Does not |
| --- | --- |
| `box`, `cylinder` (round, faceted, or a hex prism), `polygon`, `pyramid`, `roof`, `wedge`, `sphere` and `halfSphere` (equal radii), `torus`, `cone` with a `topRadius` | an elliptical `sphere` or `halfSphere`, a pointed `cone`, `tube`, `ring`, `roundRoof`, `loft` |

The line is **not** curved against flat. An analytic sphere, cylinder, cone and torus all offset inwards perfectly well, and a ball hollows to the volume the arithmetic says: 40mm across with a 2mm wall is 4/3 pi (20³ - 18³) = 9081.30 mm³, exactly.

What OCCT will not offset is a **spline** skin -- at any thickness, and at every reconstruction tolerance it offers. In this app that means:

- a ball with **unequal** radii. Equal radii give a true sphere; anything else is a revolved spline, so a 40 x 40 x 20 ball is refused while a 40mm one is not.
- a pointed `cone`. Offsetting inwards from an apex has nowhere to go; give it a `topRadius` and it hollows.
- `tube`, `ring` and `roundRoof`, whose walls are built by extruding a profile, which is a spline surface however round it looks.
- `loft`, which is a spline all over by construction.

Those answer `422` saying so rather than approximating a wall, because a wall that is nearly right is a part that nearly holds water.

Cut one out instead: make the inner shape, mark it `hole: true`, and `POST /booleans`. That is a different operation with a different result -- a boolean cavity has the shape you gave it rather than a constant wall -- but it works on anything.

### When it refuses

| Status | When |
| --- | --- |
| `400` | No `thickness`, a thickness of zero or less, a face index out of range, or a direction that is not one of the six. |
| `404` | No such project, or no such shape in it. |
| `409` | The shape is locked, or another write holds the project. |
| `422` | A kind the server cannot build exactly, a kind OCCT will not offset, every face named open, or a wall too thick for the part. |

**A wall thicker than the part fails cleanly, and this took some doing.** Past the thickness that fits, OCCT does not raise an error: depending on the shape and the faces left open it hands back an empty compound, a solid that fails its own validity check while reporting the right bounding box, or -- worst -- the original solid untouched, valid and the right size, having hollowed nothing at all. None of those is distinguishable by extents, so the server weighs the result: hollowing always removes the cavity, and a result that weighs what it started at did nothing. All three answer `422` and the project is left exactly as it was.

Leaving **every** face open is refused too. It would take the walls away rather than hollow anything, and OCCT's answer to it is the original solid, which is the one answer a script cannot tell from success.

## Example: a plate with a row of holes

```bash
TOKEN=...   # SKETCHFORGE_API_TOKEN
HOST=http://localhost:3000/api/v1

PROJECT=$(curl -s -X POST "$HOST/projects" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"Hole plate"}' | python3 -c 'import json,sys; print(json.load(sys.stdin)["project"]["id"])')

python3 - "$PROJECT" "$TOKEN" <<'PY'
import json, sys, urllib.request
project, token = sys.argv[1], sys.argv[2]
shapes = [{"kind": "box", "width": 120, "depth": 40, "height": 6, "name": "Plate"}]
for index in range(5):
    shapes.append({
        "kind": "cylinder", "width": 8, "depth": 8, "height": 12,
        "x": -40 + index * 20, "elevation": -1, "hole": True,
        "name": f"Hole {index + 1}",
    })
request = urllib.request.Request(
    f"http://localhost:3000/api/v1/shapes?projectId={project}",
    data=json.dumps({"shapes": shapes}).encode(),
    headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
)
print(urllib.request.urlopen(request).status)
PY
```

Open the project in the dashboard afterwards; the holes are ordinary shapes marked as holes, so grouping the plate with them cuts them out -- or ask the server to do it, with the boolean endpoint below.

## Combining shapes: cut, group, separate

A parameterised part is rarely one shape. A bracket is a plate with holes in it, and until the holes are taken out of the plate it is a plate and some cylinders -- which is where a script that can only add shapes runs out of road.

Grouping is how this app subtracts. A group is one shape carrying its members; a member marked `hole: true` is subtracted from the rest when the group is made. So `POST /groups` and `POST /booleans` are one operation with two front doors: the first takes a flat list of ids and reads each shape's own `hole` flag, the second names the two roles explicitly and does not care how the shapes were stored.

```bash
# Cut: name the solid and the holes, whatever their stored hole flag says
curl -X POST "$HOST/booleans?projectId=$PROJECT" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"solidIds":["<plate>"],"holeIds":["<hole 1>","<hole 2>"]}'

# Group: the same thing, from the shapes' own hole flags
curl -X POST "$HOST/groups?projectId=$PROJECT" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"ids":["<plate>","<hole 1>"]}'

# Ungroup, and split a cut result into the separate bodies it left behind
curl -X DELETE "$HOST/groups?projectId=$PROJECT&shapeId=<group>" -H "Authorization: Bearer $TOKEN"
curl -X POST "$HOST/parts?projectId=$PROJECT&shapeId=<group>" -H "Authorization: Bearer $TOKEN"
```

Either way the operands leave the project and one group takes their place, carrying them as its children -- so the result opens in the editor as an ordinary group, and ungrouping there gives back the shapes it was made from. `solidIds` and `holeIds` each accept a single id as well as a list.

Every solid named is fused before any hole is taken out, so a hole spanning two touching plates goes through both rather than through whichever was cut first. A group named as an operand is taken apart first and its members become the operands, so cutting into a group cuts the shapes inside it.

### What the cut works from

Shapes are rebuilt as exact geometry by the same builders the fillet endpoint uses, so the kinds listed under "What it can work from" above are the kinds a cut can take; anything else answers `422` naming it. A shape that already carries a mesh -- an import, or anything previously cut or treated -- is cut from that mesh, because the triangles are the only description of it the project has.

The result is stored the way the editor stores a cut: a mesh of the solid, with the operands kept as the group's children. Unlike the editor, the server also stores the exact geometry alongside it, so a fillet or a STEP export of a cut part reads true surfaces rather than triangles.

The editor grows every cutter by 0.05mm before subtracting it, because a mesh CSG resolves two coplanar faces unpredictably. An exact boolean does not need that dodge, so a hole cut here is the size that was asked for -- a flush-bottomed pocket comes out at its stated depth rather than 0.05mm deeper.

### Separating parts

A cut often leaves several pieces -- a bar cut through the middle is two bars -- and until they are separate shapes a script cannot move, colour or export one of them. `POST /parts` splits a shape into the bodies that touch, or takes a plain group back into its members.

A shape built from parameters is one body by construction, so it answers `422` saying so. A multi-glyph text shape is the one case the server gets wrong here: the editor can split it into letters and the server cannot see them, because the glyph outlines come from a font it does not load. Separate those in the editor.

### When it refuses

| Status | When |
| --- | --- |
| `400` | No `solidIds`, no `holeIds`, or a shape named in both. |
| `404` | An id that is not in the project. |
| `409` | A locked operand, or another write holds the project. |
| `422` | A kind the server cannot build exactly, or a cut that would leave nothing behind. |

A cut that removes the whole solid is refused and the project is left as it was, rather than the shapes quietly disappearing -- which is what the editor does with the same selection, and is much harder to notice from a script.

## What a write does to the project

A shape write unpacks the project's `.skf`, changes the shape list, and packs it again. The project's own settings -- workspace, snap grid, placement workplane -- and any imported model's source file are carried through untouched, and the change lands as one more undo step rather than clearing the stack, so whoever opens the project next can undo past it.

Writes take a per-project lock and answer `409` if another write holds it.
