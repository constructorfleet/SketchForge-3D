# REST API

A scripting surface for SketchForge projects (upstream issue [#55](https://github.com/Formsmith746/SketchForge-3D/issues/55)). Shapes are described as data, so an LLM or a build script can generate a parameterised design -- a plate with a computed row of holes, a family of brackets at four sizes -- without driving the editor.

It is **headless**: it reads and writes the projects that server-side storage holds, with no browser open anywhere. A dashboard that has the project open picks the change up on its next load, because every write advances the project's revision.

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

All paths are under `/api/v1`. Bodies and responses are JSON; errors are `{ "error": "..." }` with a meaningful status.

| Method | Path | Does |
| --- | --- | --- |
| `GET` | `/projects` | Lists projects: id, name, shape count, revision. |
| `GET` | `/projects?projectId=` | One project with its shapes and settings. |
| `POST` | `/projects` | Creates an empty project. Body: `{ "name": "Bracket" }`. |
| `DELETE` | `/projects?projectId=` | Deletes the project and its geometry. |
| `GET` | `/shapes?projectId=` | The project's shapes. |
| `POST` | `/shapes?projectId=` | Adds one shape, or a batch via `{ "shapes": [...] }` (max 200). |
| `PATCH` | `/shapes?projectId=&shapeId=` | Changes the fields you send and leaves the rest. |
| `DELETE` | `/shapes?projectId=&shapeId=` | Removes one shape. |

The project and shape are named in the query string rather than the path. That is not a style choice: a dynamic path segment makes the static-export build fail outright, because an exported build has no server to resolve one against. The dashboard's own routes are shaped this way for the same reason.

## Describing a shape

```json
{ "kind": "cylinder", "width": 8, "height": 30, "sides": 6, "x": 12, "name": "Post" }
```

`kind` is one of `box`, `cube`, `cylinder`, `cone`, `sphere`, `halfSphere`, `torus`, `tube`, `ring`, `polygon`, `pyramid`, `roof`, `roundRoof`, `wedge`, `icosahedron`, `text`, `loft`, `gear`. A `cube` is a box whose sides match, and `size` stands in for `width`, `depth`, and `height` together. Only `mesh`, `sketch`, and `scribble` are left out: those need geometry or a drawn profile rather than numbers.

Common fields: `name`, `color`, `x`, `z`, `elevation`, `width`, `depth`, `height`, `rotation`, `rotationX`, `rotationZ`, `hole`.

Per kind:

| Fields | For |
| --- | --- |
| `sides` | `cylinder` (6 gives a hex prism), `pyramid` (4 unless you say otherwise), `cone` |
| `bevel` | `tube` and `ring` -- the wall thickness, measured inwards |
| `topRadius` | `cone` |
| `steps` | `sphere`, `halfSphere` |
| `text`, `font`, `bevel`, `segments` | `text` |
| `teeth`, `toothSize`, `toothWidth`, `centerHoleSize`, `helixAngle` | `gear` |
| `loftBottomShape`, `loftTopShape`, `loftTopWidth`, `loftTopDepth`, `loftBottomRotation`, `loftTopRotation`, `loftSegments`, `loftLayers` | `loft` |

Dimensions are clamped to 0.01-10000 mm. Anything missing takes the same default the editor would have used, so a request need only carry what it cares about.

**Sketch extrusions, fillets, chamfers, and boolean operations are not available here.** Their geometry comes from OCCT, which runs in the editor's worker; the API builds only what can be built from parameters alone, and answers `422` naming the kinds it can build rather than quietly substituting something else.

A locked shape answers `409` to a change or delete; send `locked: false` to unlock it.

## Fillets and chamfers, on the server

The editor rounds and cuts edges in a browser worker: every client downloads a 22 MB CAD kernel and runs the solid modelling on whatever hardware it has. These two endpoints do it on the server instead, which is also the only way a script can ask for geometry that cannot be described as parameters.

| Method | Path | Does |
| --- | --- | --- |
| `GET` | `/edges?projectId=&shapeId=` | The shape's edges: index, length, curve type, midpoint. |
| `POST` | `/treatments?projectId=&shapeId=` | Applies a fillet or chamfer. |

```bash
# Every edge
curl -X POST "$HOST/projects/$PROJECT/shapes/$SHAPE/treatments"   -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json"   -d '{"kind":"fillet","amount":3}'

# Named edges, by the index the edges endpoint gave them
curl -X POST "$HOST/projects/$PROJECT/shapes/$SHAPE/treatments"   -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json"   -d '{"kind":"chamfer","amount":2,"angle":30,"edges":[0,1,2,3]}'
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

Open the project in the dashboard afterwards; the holes are ordinary shapes marked as holes, so grouping the plate with them cuts them out.

## What a write does to the project

A shape write unpacks the project's `.skf`, changes the shape list, and packs it again. The project's own settings -- workspace, snap grid, placement workplane -- and any imported model's source file are carried through untouched, and the change lands as one more undo step rather than clearing the stack, so whoever opens the project next can undo past it.

Writes take a per-project lock and answer `409` if another write holds it.
