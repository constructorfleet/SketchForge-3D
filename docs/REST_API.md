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
| `POST` | `/projects` | Creates an empty project. Body: `{ "name": "Bracket" }`. |
| `GET` | `/projects/{id}` | One project with its shapes and settings. |
| `DELETE` | `/projects/{id}` | Deletes the project and its geometry. |
| `GET` | `/projects/{id}/shapes` | The project's shapes. |
| `POST` | `/projects/{id}/shapes` | Adds one shape, or a batch via `{ "shapes": [...] }` (max 200). |
| `PATCH` | `/projects/{id}/shapes/{shapeId}` | Changes the fields you send and leaves the rest. |
| `DELETE` | `/projects/{id}/shapes/{shapeId}` | Removes one shape. |

## Describing a shape

```json
{ "kind": "cylinder", "width": 8, "height": 30, "sides": 6, "x": 12, "name": "Post" }
```

`kind` is one of `box`, `cube`, `cylinder`, `text`, `loft`. A `cube` is a box whose sides match, and `size` stands in for `width`, `depth`, and `height` together.

Common fields: `name`, `color`, `x`, `z`, `elevation`, `width`, `depth`, `height`, `rotation`, `rotationX`, `rotationZ`, `hole`. Per kind: `sides` (cylinder -- 6 gives a hex prism); `text`, `font`, `bevel`, `segments` (text); `loftBottomShape`, `loftTopShape`, `loftTopWidth`, `loftTopDepth`, `loftBottomRotation`, `loftTopRotation`, `loftSegments`, `loftLayers` (loft).

Dimensions are clamped to 0.01-10000 mm. Anything missing takes the same default the editor would have used, so a request need only carry what it cares about.

**Sketch extrusions, fillets, chamfers, and boolean operations are not available here.** Their geometry comes from OCCT, which runs in the editor's worker; the API builds only what can be built from parameters alone, and answers `422` naming the kinds it can build rather than quietly substituting something else.

A locked shape answers `409` to a change or delete; send `locked: false` to unlock it.

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
    f"http://localhost:3000/api/v1/projects/{project}/shapes",
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
