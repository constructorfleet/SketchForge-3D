# SketchForge engine

`@constructorfleet/sketchforge-engine` is the TypeScript package for SketchForge's project model and geometry operations. It is intended for Node.js applications that need to read or change SketchForge projects, construct parameterized shapes, or import and export geometry without running the web editor.

## Node compatibility

The package manifest declares Node.js 20 or newer, but that range is broader than the runtime supported by its full geometry stack: the locked `brepjs` dependency requires Node.js 24 or newer. Use Node.js 24+ for the complete engine, including exact CAD and kernel-backed operations. On Node.js 20–23, npm may warn about the dependency engine requirement, and full engine behavior is unsupported. The package's engine range should be aligned with this dependency in a future package release.

## Installation

```sh
npm install @constructorfleet/sketchforge-engine
```

The package is ECMAScript modules (ESM). TypeScript declarations ship with the package; no separate `@types` package is needed.

## Quick start

Build a shape from parameters without starting the editor or opening a project:

```js
import { shapeFromRequest } from "@constructorfleet/sketchforge-engine";

const shape = shapeFromRequest({ kind: "box", width: 20, depth: 10, height: 5 });
if (!shape) throw new Error("The requested shape could not be built");
console.log(shape.kind, shape.width, shape.depth, shape.height);
```

The shape request is plain data and can be stored or passed to `createEngine`. `shapeFromRequest` returns `null` for kinds that cannot be created from parameters alone (for example, a mesh with no geometry).

To run project operations, bind an engine to the directory store used by SketchForge:

```js
import { createEngine, directoryProjectStore } from "@constructorfleet/sketchforge-engine";

const projectsDirectory = process.env.SKETCHFORGE_PROJECTS_DIR;
if (!projectsDirectory) throw new Error("Set SKETCHFORGE_PROJECTS_DIR to the project directory");
const engine = createEngine(directoryProjectStore(projectsDirectory));
const result = await engine.project("project-id");
if (!result.ok) throw new Error(`Could not read project: ${result.failure.reason}`);
console.log(`Revision ${result.value.revision}; ${result.value.shapes.length} shapes`);
```

Set `SKETCHFORGE_PROJECTS_DIR` to the directory already used by SketchForge, and replace `project-id` with an existing project ID. The directory must contain projects in the supported on-disk format. Keep access to that directory restricted to trusted local code: this package is a geometry/project library, not an HTTP service or an access-control boundary.

## Public API

The package root is the supported import surface. Its main engine facade is `Engine`, created with `createEngine(store)`. Every operation returns an `EngineResult<T>`; check `ok` before reading `value` or `failure`.

| Area | `Engine` methods | What they do |
| --- | --- | --- |
| Read and edit a project | `project`, `addShapes`, `changeShape`, `removeShape` | Read placed shapes and project metadata; add parameterized shapes or change/remove an existing shape. |
| Arrange and repeat | `align`, `distribute`, `pattern`, `mirrorBaked` | Place selected shapes on a shared axis, spread them, create linear/circular copies, or mirror supported solids. |
| Import and combine | `importMesh`, `cut`, `group`, `ungroup`, `separate`, `explode` | Import model files, subtract/group solids, split groups/bodies, or explode a retained STEP assembly. |
| Inspect and measure | `edges`, `faces`, `measurements`, `properties`, `measureBetween`, `interference` | Query exact geometry topology, shape properties, distances/angles, and gaps/overlaps. |
| Modify exact geometry | `treat`, `draftPrism`, `shell`, `changeShape` | Apply edge treatments, draft an extruded prism, retain bounded sketch face drafts, or hollow a shape. |
| Parameters and bindings | `addParameter`, `updateParameter`, `renameParameter`, `deleteParameter`, `bindShapeField` | Change the project parameter table and bind shape or feature fields to expressions; bound geometry is recomputed in the same write. |

These operations address an **existing project ID** in a `ProjectStore`; this package does not create projects, project records, or initialize a project directory. `addShapes` is the first write operation for a project that already exists. All writes persist to the configured store.

The main entry point also exports these API areas:

- **Projects and operations:** `directoryProjectStore`, `createEngine`, `Engine`, `EngineResult`, `EngineFailure`, project and operation request/result types.
- **Shape requests:** `shapeFromRequest`, `shapeWithRequestedChanges`, `REQUESTABLE_SHAPE_KINDS`, plus types describing parameterized shapes.
- **Project files and exchange:** `.skf` import/export and inspection; mesh import; STEP and scene export; SVG/DXF section output; STEP assembly explosion.
- **Geometry and CAD:** primitive builders, exact solids, sectioning, topology analysis, shape bounds, CAD measurements, shelling, edge treatments, wall thickness, and projection layouts.
- **Placement and repetition:** align/distribute helpers, pattern placement helpers, shape bounds, mirror, canonicalization, and workplane hole-mode helpers.

See the [generated TypeScript API reference](https://constructorfleet.github.io/SketchForge-3D/docs/reference/typescript-engine) for every symbol and declaration. The reference links back to this usage guide. Related documentation: [REST API](https://constructorfleet.github.io/SketchForge-3D/docs/REST_API), [project format](https://constructorfleet.github.io/SketchForge-3D/docs/SKF_PROJECT_FORMAT), and [TypeScript client](https://constructorfleet.github.io/SketchForge-3D/docs/packages/typescript-client).

## Parameter expressions

`evaluateExpression(expression, scope, expectedDimension)` evaluates a unit-aware expression and never throws. It returns `{ ok: true, value, dimension }` with the value in base units (millimetres for length, degrees for angle, mm² for area), or `{ ok: false, error: { code, message, span } }`.

```js
import { evaluateExpression, resolveParameterTable } from "@constructorfleet/sketchforge-engine";

const table = resolveParameterTable([
  { name: "wall", expression: "0.1in" },
  { name: "outer", expression: "inner + 2 * wall", dimension: "length" },
  { name: "inner", expression: "20", dimension: "length" },
]);
console.log(table.scope.get("outer")?.value); // 25.08
console.log(evaluateExpression("wall * wall", table.scope, "length").ok); // false: an area
```

- **Syntax:** `+ - * /`, unary minus, parentheses, parameter names, and numbers with an optional unit: `mm`, `cm`, `m`, `in`, `ft`, `deg`, `rad` (`10mm`, `10 mm`).
- **Functions:** `min`, `max`, `abs`, `sqrt`, `round`, `floor`, `ceil`, `sin`, `cos`, `tan`. Trig takes an angle. Rounding works on the base-unit value, so `floor(1in)` is 25 mm.
- **Dimensions:** length, angle and their products. `wall * 2` is a length, `wall * wall` is an area, `wall / wall` is unitless, and length plus angle is an error.
- **Bare numbers:** a number without a unit has no dimension until context gives one. Under `+`, `-`, `min` and `max` it takes the other operand's dimension (`wall + 3` is wall + 3 mm). Under `*` and `/` it is a unitless factor. `abs`, `round`, `floor`, `ceil`, `sqrt`, and `min` or `max` of only bare arguments keep it bare, so `wall + abs(-3)` is wall + 3 mm and `sqrt(16)` in a length field is 4 mm. As a trig argument it is degrees. If the whole result is still bare, it takes the field dimension: `3` and `2 * 3` in a length field are 3 mm and 6 mm. With no field dimension it is unitless. Unit literals, parameters and trig results are never bare, so `wall + count` (a unitless parameter) and `wall + cos(0)` are errors.
- **Errors:** `parseError`, `unknownName`, `unknownFunction`, `argumentCount`, `dimensionMismatch`, `divisionByZero`, `nonFinite`, `invalidArgument` (a non-string expression, a scope that is not an object, a scope value that is not a number), `invalidDimension` (an unknown dimension name such as `"Length"`, or a record without integer `length` and `angle`), and `limitExceeded`. The table adds `cycle`, `dependencyFailed`, `invalidName` and `duplicateName`.
- **Limits:** an expression may be 10,000 characters and nest parentheses and calls 128 deep. A table may hold 10,000 entries.
- **Cycles:** every parameter in one group of mutually referencing parameters gets the same `cycle` path, which starts and ends at the group's first entry. Its span marks that parameter's reference to the next one on the path.
- **Names:** `isValidParameterName` accepts ASCII identifiers up to 64 characters that are not unit or function names. A non-ASCII letter is an invalid character, so `wäll` reads as `w` and `ll`. `expressionDependencies` lists referenced names; `renameExpressionReference` renames whole references only, so `wall2`, unit suffixes and function calls stay unchanged. It does not check whether the new name is already in use; the caller must.

### The project parameter table

A project holds one parameter table for the whole project. Each `ProjectParameter` has a `name`, an `expression`, a declared `dimension` (`"length"`, `"angle"` or `"unitless"`), and a cached `value` in mm, degrees or plain units. The dimension is required so a bare number resolves: `3` is 3 mm in a length parameter and 3 degrees in an angle parameter.

```js
import { addParameter, deleteParameter, renameParameter, updateParameter } from "@constructorfleet/sketchforge-engine";

let project = { parameters: [] };
for (const input of [
  { name: "wall", expression: "2", dimension: "length" },
  { name: "outer", expression: "20 + 2 * wall", dimension: "length" },
]) {
  const result = addParameter(project, input);
  if (!result.ok) throw new Error(result.error.message);
  project = result.project;
}
project = updateParameter(project, "wall", { expression: "3 mm" }).project; // outer is now 26
project = renameParameter(project, "wall", "shell").project; // outer reads "20 + 2 * shell"
console.log(deleteParameter(project, "shell").error); // { code: "parameterInUse", dependents: ["outer"], ... }
```

- **Operations:** `addParameter`, `updateParameter` (expression, dimension or both), `renameParameter` and `deleteParameter` take any object with a `parameters` array (missing reads as empty) and return `{ ok: true, project }` with a new object, or `{ ok: false, error }`. They never throw and never change their input. Each re-evaluates the whole table, so dependents get new values. A change is refused when the parameter it changes does not resolve, or when it breaks a parameter that resolved before.
- **Errors:** `{ code, message, parameter }`, where `parameter` names the entry that failed, which can be a dependent of the one changed. Codes are `invalidParameter` (an entry or table that is not an object or list), `invalidName`, `duplicateName`, `invalidDimension`, `invalidExpression` (with the evaluator's `expressionError`, including `cycle` and its path), `unknownParameter`, `parameterInUse` (with the `dependents` that reference it directly) and `tooManyParameters`. A table holds up to `PROJECT_PARAMETER_LIMIT` (2,000) entries.
- **Rename** checks the new name, refuses one already in use, and rewrites every expression that references the old name. **Delete** refuses while another parameter references the parameter; `parameterDependents` lists those parameters.
- **Values:** `resolveProjectParameters` evaluates a table and ignores any cached `value`. `.skf` export and import both call it, so a stored value is never trusted over its expression. It fails only on malformed structure. An entry that does not resolve stays in the table with an `error` and keeps its stored `value` as its last known value (`NaN` when there is none), so a project whose table a later release can no longer resolve still opens and saves the table back unchanged. Other entries can still be added, changed and deleted around it. `error` is never written to `.skf`.
- **Storage:** `.skf` packages and `ProjectDocument.parameters` carry the table. See the [project format](https://constructorfleet.github.io/SketchForge-3D/docs/SKF_PROJECT_FORMAT) for the format version rules.

### Binding shape and feature fields

A shape keeps the resolved number in its normal field (`width`, `x`, `sweepAngle` and so on) and records the expression in `shape.expressions`, keyed by field. Kernels, exports and older readers read only the number.

```ts
await engine.addParameter(projectId, { name: "wall", expression: "2 mm", dimension: "length" });
await engine.bindShapeField(projectId, boxId, "width", "wall * 5"); // width is now 10
await engine.updateParameter(projectId, "wall", { expression: "3" }); // width is now 15, in the same write
await engine.changeShape(projectId, boxId, { width: 12 }); // a literal removes the width binding
```

- **Catalog:** `EXPRESSION_BINDABLE_FIELDS` lists every bindable field once, with its `dimension` (`length`, `angle` or `unitless`), `integer` for counts, the `kinds` that carry it, any retained feature it `requires`, static `min` and `max` bounds (`exclusive` for drafts, treatment amounts and chamfer angles), and `periodic` for angles stored modulo 360. `bindableFieldsFor(shape)` and `bindableField(shape, field)` answer for one shape. A bare number takes the field's unit, so `3` in `width` is 3 mm and in `rotation` is 3°.
- **Fields:** placement and size (`x`, `z`, `elevation`, `width`, `depth`, `height`, `rotation`, `rotationX`, `rotationZ`), the numeric kind parameters (`sides`, `bevel`, `teeth`, `loftTopWidth` and the rest), and the retained-feature settings `revolve.startAngle`, `revolve.sweepAngle`, `revolve.sides`, `revolve.quality`, `revolve.pitch`, `revolve.turns`, `revolve.coreRadius`, `draftPrismAngle`, `faceDraft.angle`, `edgeTreatments.0.amount` and `edgeTreatments.0.chamferAngle`. Shape fields (`target: "shape"`) bind on top-level shapes only; feature fields also bind on a sketch output inside a group.
- **Recompute:** `updateParameter` re-resolves the table, then every binding whose expression references a parameter whose value or dimension changed, children before their groups. Each value is applied through the path a manual edit takes: treatment settings rebuild the sketch recipe through `recompute`, feature settings go through `changeShape` by `sketchSourceId`, and shape fields through `changeShape` by ID. Retained fillets, chamfers, drafts and boolean ancestors replay as they do for a manual edit, and a shell refuses a rebuild as it does for a manual edit. Treatment settings bind only on sketch-backed shapes, because no manual edit replays a treatment on a plain solid.
- **Recompute without a kernel:** `planParameterBindings(shapes, previous, next)` (`@constructorfleet/sketchforge-engine/parameterBindingPlan`) plans a table change with no CAD work, and refuses as `updateParameter` does. `applyKernelFreeBindings` from the same module plans and applies the change when every shape it moves is a plain top-level primitive (`plainPrimitive(shape)`), and returns `null` when kernel work is needed. The editor's static build uses it.
- **Ranges:** a value the field would clamp or round is refused rather than stored differently from its expression: `outOfRange` carries the `value`, the static `min` and `max` where the field has them, and the `stored` value it would become. Fields bounded by the shape itself, such as a gear's tooth size, report only `stored`. A shape's bindings are checked together against the shape as the whole change leaves it (`resolveShapeBindings`), so a tooth size that grows with its blank is accepted, and a fixed one the blank shrinks under is refused even though its own parameter did not change. A periodic angle is accepted and resolved to its stored form, so `-30` in `rotation` or `revolve.startAngle` is 330 and `12.34` in `rotation` is 12.3. A value that already matches the stored one is not reapplied.
- **Errors:** nothing is written unless every step succeeds. A table error is `parameter_invalid` with the table error. A binding that does not resolve is `binding_invalid` with `{ code, shapeId, field, message, expressionError? }`, where `code` is `fieldNotBindable`, `invalidExpression` (wrong dimension, unknown name, cycle), `notAnInteger`, `outOfRange` or `conflictingBinding` (with `constraintIds`; see "One dimension, one binding" below). A change that would alter a locked shape, or rebuild a locked group around a bound child, is refused as a whole with `binding_failed` and `shape_locked`; so is a value the geometry refuses, with the underlying failure.
- **Undo:** each operation is one write and so one history entry. History entries carry the parameter table (`EditorHistoryEntry.parameters`) with the shapes, so one undo restores the old table and the old geometry together. An empty table keeps the previous shapes-only fingerprint. An entry without `parameters`, written before tables were in history, means the table is unknown: it matches the current scene by shapes alone, and undoing to it keeps the current table.
- **Bindings in a request:** `addShapes` and `changeShape` accept `expressions: { width: "wall * 5" }`, applied in the same write as the rest of the request. `changeShape` also accepts `null` to clear a binding. On create, a number sent for the same field must equal the expression's value. On a change, an entry equal to the stored expression is an echo and is not re-evaluated; a changed expression with an unchanged number rebinds; a changed number with an unchanged expression unbinds; both changed and disagreeing is `invalid_shape_request` with `shapeId` and `field`. `project()` returns the resolved table as `parameters`.
- **Literal edits:** `changeShape` removes the binding of every field it sets to a new value, and of any bound field whose value its rebuild changes, such as a revolve's height after a new pitch. A bound placement field is the exception: a rebuild that moves it puts it back (see "Bound placement" below). Bindings on fields a rebuild leaves alone are kept, and a number equal to the current value keeps its binding, so a shape read back and sent whole stays bound. Other operations that set a bound value also remove its binding: `align` and `distribute` drop the moved axis, `pattern` copies drop `x`, `z` and a turned `rotation`, `treat` drops treatment bindings, `draftPrism` drops `draftPrismAngle`, and `group` and `cut` drop the shape-field bindings of their operands, whose placement becomes group-local, `ungroup` drops them from the children it returns to world placement, `mirrorBaked` drops them from baked results, and `separate` and `explode` drop every binding from the new parts. The editor does not apply this rule yet (#617).
- **Rename and delete:** `renameParameter` rewrites shape bindings too, including treatment `before` snapshots. `deleteParameter` refuses while a shape or a `before` snapshot binds the parameter and reports `shapeDependents: [{ shapeId, fields }]`; `projectParameterDependents(project, name)` lists both kinds of dependent.
- **Stale bindings:** a binding that no longer resolves, or names a field the shape lacks, is kept with its stored number. `.skf` import reports it in `bindingIssues`, and `shapeBindingIssues(shapes, parameters)` lists them on demand. A parameter change re-resolves only the bindings that depend on it. One that was already stale stays stale and does not block the change; one the change itself breaks refuses it. A shape field bound on a shape inside a group is stale too.

### Binding sketch constraints

A dimensional sketch constraint keeps its resolved number in `valueMm` or `valueDeg` and records the expression next to it in `expression`. The solver, kernels and older readers read only the number.

```ts
await engine.addParameter(projectId, { name: "slot", expression: "12 mm", dimension: "length" });
await engine.bindSketchConstraint(projectId, sketchSourceId, "slot-length", "slot"); // re-solves, rebuilds
await engine.updateParameter(projectId, "slot", { expression: "16" }); // re-solves again, same write
await engine.bindSketchConstraint(projectId, sketchSourceId, "slot-length", null); // keeps 16 mm, unbound
```

- **Catalog:** `SKETCH_CONSTRAINT_BINDABLE_KINDS` lists the kinds that bind: `distance`, `radius` and `diameter` (length, `valueMm`) and `angle` (angle, `valueDeg`). Other kinds, including `fixed`, have no value to bind. A bare number takes the constraint's unit. A resolved distance must not be negative, a radius or diameter must be positive, and an angle must be between 0° and 180°, the same ranges the `.skf` reader accepts; anything else is `outOfRange`.
- **Target:** `bindSketchConstraint(projectId, shapeId, constraintId, expression | null)` takes the sketch output's ID or its `sketchSourceId`, including an output nested in a boolean group. A locked output, or one inside a locked group, refuses binding, re-binding and unbinding with `shape_locked` naming the locked shape.
- **Create:** `addShapes` checks constraint expressions in a supplied profile (a `sketchSweep` today). The expression wins over the supplied value, as shape expressions do on create, and the sketch is solved and built with the resolved values. An expression on a kind that cannot bind, one that does not resolve, or one on a sketch that cannot be rebuilt refuses the request with `constraint_binding_invalid`, and nothing is written.
- **Recompute:** a parameter change resolves the constraint bindings that use it, sets the new values and solves each affected sketch with `solveSketchConstraints` before any rebuild. Each solved profile is then applied as `changeShape(sketchSourceId, { sketchProfile })` would apply it, so the extrusion, revolve or sweep is rebuilt and retained treatments, drafts and boolean ancestors replay. Shape fields and sketch constraints change in the same write, so one undo step restores the table, the profiles and the geometry. The solve covers the whole sketch, as a solve in the editor does: a literal constraint stored with a value its points do not meet is enforced too, and its points move.
- **Errors:** nothing is written unless every sketch solves and every rebuild succeeds. A sketch that cannot satisfy its constraints with the new values (for example over-constrained) is `sketch_unsolvable` with `{ shapeId, constraintIds, message }`. Only constraints the change breaks count: a changed constraint, or one that was satisfied before. The editor can save a sketch with constraints it could not satisfy, and those do not block a change. A constraint binding that does not resolve is `constraint_binding_invalid` with `{ code, shapeId, constraintId, message, expressionError? }`, where `code` is `constraintNotFound`, `constraintNotBindable`, `invalidExpression`, `outOfRange`, `sketchNotRebuildable` (the shape has a profile but no `sketchOperation`, is nested without a `sketchSourceId`, or is shelled, so no profile edit can rebuild it) or `conflictingBinding` (with `fields`; see below). During a parameter change, a rebuild the geometry refuses, or a locked output, is `binding_failed` with the output's ID, `constraintIds` and the underlying failure. `bindSketchConstraint` on a locked output returns `shape_locked`.
- **One dimension, one binding:** a bound `width`, `depth` or `height` on a sketch output is applied as a resize after the profile is solved, so it would overrule the constraints and leave them describing a different solid. A sketch output therefore holds either constraint bindings or bindings on the size fields its profile determines, not both. Those fields are `profileSizeFields(shape)`: `width` and `depth` for an extrusion, and `width`, `depth` and `height` for a revolve or sweep. An extrusion's `height` is its extrusion distance, not part of the profile, so it binds next to constraint bindings. Binding the second side is refused, whichever comes first, by `bindShapeField`, `bindSketchConstraint`, `addShapes` and `changeShape`: a field is `binding_invalid` with `code: "conflictingBinding"` and the bound `constraintIds`, and a constraint is `constraint_binding_invalid` with `code: "conflictingBinding"` and the bound `fields`. Clearing either side is never refused. A literal size that changes one of those fields through `changeShape` is a resize of the solved sketch, so it removes the sketch's constraint bindings: each constraint keeps its resolved number, and the solid scales as before. Sending the current size back is an echo and keeps them. A project that already holds both, such as one written before this check, still loads and recomputes, with the size field applied last; `sketchConstraintBindingIssues` and `.skf` import report each such constraint as `conflictingBinding`.
- **Binding validation:** `validateBinding({ roots, target, parameters }, change)` holds every rule a new binding must pass, and every bind path runs it: `bindShapeField`, `bindSketchConstraint`, `addShapes`, `changeShape` and the editor's own checks. `change` is `{ field, expression }` or `{ constraintId, constraint, expression }`. It checks, in this order, the lock, where the binding may sit (a shape field on a top-level shape, a constraint on a sketch with a rebuild recipe), the expression against `parameters`, and then conflicts with bindings already in the tree: profile size against constraints, and group size against nested bindings that refit the group, either way round. It returns the resolved value or the refusal the bind path reports. Clearing is refused only by a lock. Without `parameters` only the tree rules run. With `draft: true`, the target is an open sketch in the editor, whose lock and rebuild recipe are checked when the sketch is finished. A parameter change does not run it: it re-applies stored bindings, and a stored conflict must still recompute.
- **Bound placement:** a solve can move a sketch's centre, and so the shape's `x` and `z`. A bound placement field (`x`, `z`, `elevation`, `rotation`, `rotationX`, `rotationZ`) is put back after every profile rebuild: `bindSketchConstraint`, a parameter change, a create with constraint expressions, and a `changeShape` profile edit. The binding is never left stale or dropped by that drift, and the solid moves so its placement matches the expression. A placement the same request sets as a literal is not put back.
- **Profile edits:** `changeShape` applies the field rules to each constraint of a supplied `sketchProfile`, compared with the stored constraint (`requestedSketchProfile`). The stored value, with no expression or the stored one, keeps the binding without re-evaluating it. A changed value with no expression or the stored one replaces the binding. A changed expression with the stored value binds it, and the sketch is solved with the resolved value before the rebuild. A changed value and a changed expression must agree, or the change is `invalid_shape_request` with `shapeId` and `constraintId`. `expression: null` unbinds. A constraint the stored profile lacks takes its expression's value, as on create. A new binding is refused as `bindSketchConstraint` refuses it (`constraint_binding_invalid`, `sketch_unsolvable`), and nothing is written. A literal size that changes a profile size field in the same request as a new binding is `invalid_shape_request` with `shapeId`, `field` and `constraintId`. A locked output is refused with `shape_locked` before the profile is planned or solved. `sketchConstraints`, the read-only summary of a profile's dimensions (`sketchConstraintSummaries`), is accepted when it repeats the stored one and refused with `invalid_shape_request` and `field: "sketchConstraints"` when it differs. With a `sketchProfile`, a `width`, `depth` or `height` equal to the stored one is an echo and is not applied as a resize after the rebuild; an echoed position still applies. `literalSketchProfile` remains for callers that want every new expression dropped.
- **Rename, delete and dependents:** `renameParameter` rewrites constraint bindings too, including treatment `before` snapshots. `deleteParameter` refuses while a constraint binds the parameter and reports `sketchConstraintDependents: [{ shapeId, constraintIds }]`. `projectParameterDependents(project, name)` returns `{ parameters, shapes, sketchConstraints }`. Dependents and stale-binding issues also count bindings held only in a treatment `before` snapshot, reported once per shape, because reverting the treatment restores that snapshot.
- **Stale bindings:** a constraint binding that no longer resolves is kept with its stored value. `.skf` import reports it in `constraintBindingIssues`, and `sketchConstraintBindingIssues(shapes, parameters)` lists them on demand. It does not block an unrelated parameter change, and it is applied once a change makes it resolve. A binding on a sketch with no rebuild recipe stays stale and is reported as `sketchNotRebuildable`.
- **Solver:** `solveSketchConstraints` and the other constraint helpers moved into the engine (`@constructorfleet/sketchforge-engine/sketchConstraints`), so the server re-solves with the same solver the editor uses.

### Parameter configurations

A configuration is a named row of parameter expression overrides, for variants such as `Small` and `Large`. A parameter a row does not list keeps its base expression. A project has `configurations` (in order) and an `activeConfiguration`, which is a configuration name or `null` for the base table. Each `ProjectParameter` keeps its base `expression`, and its `value` is resolved under the active configuration, so bindings, exports and anything else that reads `value` follow the active configuration.

```ts
await engine.addParameter(projectId, { name: "wall", expression: "2", dimension: "length" });
await engine.bindShapeField(projectId, boxId, "width", "wall * 5"); // 10 mm
await engine.addConfiguration(projectId, "Large", { wall: "4" });
await engine.activateConfiguration(projectId, "Large"); // width is now 20 mm, in one write
await engine.setConfigurationOverride(projectId, "Large", "wall", "5"); // 25 mm, as Large is active
await engine.activateConfiguration(projectId, null); // back to the base table, 10 mm
```

- **Engine operations:** `addConfiguration(projectId, name, overrides?)`, `renameConfiguration`, `deleteConfiguration`, `setConfigurationOverride(projectId, configuration, parameter, expression)`, `clearConfigurationOverride` and `activateConfiguration(projectId, name | null)`. Each returns `ParametersWritten`, which now also carries `configurations` and `activeConfiguration`. Each is one write and one history entry. A change that alters active values recomputes bound shapes exactly as `updateParameter` does, with the same refusals: a locked shape (`binding_failed` with `shape_locked`), a value out of range (`binding_invalid` with `outOfRange`), or a table error. A refusal writes nothing. An operation that changes nothing, such as activating the active configuration, writes nothing.
- **Pure operations:** `addConfiguration(project, { name, overrides? })`, `renameConfiguration`, `deleteConfiguration`, `setConfigurationOverride`, `clearConfigurationOverride` and `activateConfiguration` take any object with `parameters`, `configurations` and `activeConfiguration` (missing reads as none) and return `{ ok: true, project }` or `{ ok: false, error }`. They never throw and never change their input. A project without configurations keeps no configuration fields.
- **Validation:** every change resolves the base table and every configuration's table, not only the active one. It is refused when an entry it sets does not resolve, or when it breaks an entry that resolved before, in any of those tables. So an override with the wrong dimension or a cycle is refused in a configuration that is not active, and so is a base change that breaks one. A stale override does not block edits to the parameters that read it: in the table of a configuration that is not active, an entry that fails only through a dependency that was already failing is not a refusal. The active configuration follows the base rule, so an edited entry must resolve there. A rename is refused only when it breaks an entry. Activation, and deleting the active configuration, are refused when they break an entry the current table resolves. Errors use the parameter error shape, with `configuration` naming the table that failed, and the codes `invalidConfiguration`, `invalidConfigurationName`, `duplicateConfigurationName`, `unknownConfiguration` and `tooManyConfigurations`. A name is 1 to 100 characters without control characters or surrounding whitespace. A project holds up to `PROJECT_CONFIGURATION_LIMIT` (200) configurations.
- **Parameter rename and delete:** `renameParameter` renames override keys and rewrites override expressions. `deleteParameter` refuses while an override of an existing parameter references it, with `configurationDependents` listing those configurations (`projectParameterDependents` reports them as `configurations`), and drops the deleted parameter's own overrides.
- **Reading:** `engine.project(projectId)` returns `configurations` and `activeConfiguration` with the table. `resolveConfiguration(project, name | null)` resolves any configuration's table without activating it. `configurationIssues(project)` lists overrides that do not resolve although the base entry does, and overrides that name no parameter.
- **Undo:** history entries carry `configurations` and `activeConfiguration` with the shapes and the table, so one undo of an activation restores the previous configuration and its geometry. Empty configurations keep the previous fingerprint. An entry without `configurations` predates them: it matches by what it knows, and undoing to it keeps the current configurations.
- **Storage:** `.skf` packages and `ProjectDocument.configurations` and `.activeConfiguration` carry them. A project with configurations is saved as format version 4, so older readers refuse it rather than drop them. Loading keeps a stale override as stored and reports it in `configurationIssues`.

## Editing a sketch-backed feature

Sketch extrusions, revolves, and sweeps expose a stable `sketchSourceId` on the generated shape. Pass that ID to `engine.changeShape(projectId, sketchSourceId, { sketchProfile })` to rebuild the feature. For a persisted sketch revolve, the same source ID also accepts operation-setting updates such as `{ sides: 64 }`. A draft prism retains its `draftPrismAngle`; source edits accept `{ draftPrismAngle: 12 }` and reapply the draft when the extrusion profile changes. Retained sketch extrusions, sweeps, and eligible revolves can store one face draft with `{ faceDraft: { sourceFaceId, angle, pullDirection } }`; use the ID from `engine.faces`, and use `null` to clear it. Profile edits resolve the selected planar face by its stored normal and require exactly one match; they never carry the old face index forward. `.skf` round trips preserve the face draft and source frame. A single-loop sketch extrusion can combine one face draft followed by one all-edge fillet. A single-section, no-hole sketch sweep can combine one face draft followed by one all-edge fillet or one symmetric 45° all-edge chamfer. Sweep treatments replay the source, draft, then treatment on profile edits, including after archive import; tests cover the round trip, replay, unsupported angles, and atomic refusal. Sweep face drafts do not support multiple sections, section holes, selected-edge treatments, or additional treatments. A plain single-region full-turn sketch revolve can combine one face draft followed by either one symmetric 45° all-edge chamfer or one all-edge fillet; profile and setting edits replay the source, draft, then treatment, including after archive import. Other face-draft treatment combinations, prism drafts, and shelling remain unsupported. When the output is nested inside a baked boolean group, the engine updates the sketch output and recomputes its boolean ancestors from their retained operands before writing the project. Each rebuilt ancestor is placed through its group's frame the way ungrouping places the group's children, so a group that was moved, turned, mirrored or resized after creation keeps that placement, mirror and scale across the edit. The edit is atomic: invalid profiles, missing or ambiguous face matches, or a failed dependent rebuild leave the stored project unchanged. A locked output, or one inside a locked group, refuses every source edit with `shape_locked` naming the locked shape or the nearest locked group, before any field is checked. `locked: false` in the request lifts only the addressed shape's own lock, so unlock the group by its own ID first. When the locked shape is itself nested, the failure adds `topLevelId`, the top-level group holding it: no call reaches a nested shape by ID, so only `ungroup` brings it back to the top level to unlock. Every other operation that targets a shape by ID (`treat`, `draftPrism`, `shell`, `mirrorBaked`, `align`, `distribute`, `pattern`, `removeShape`, `ungroup`, `separate`, `explode`) reaches only top-level shapes, so a group's child answers `shapes_not_found`.

This recomputation currently covers sketch-backed extrusions, revolves, and sweeps nested under boolean groups, plus a retained prism-draft angle applied to a sketch extrusion. Other downstream operations remain baked or unsupported for source-driven recompute, and a general-purpose feature graph is not yet available. `.skf` export preserves the updated sketch profile, draft angle, and recomputed boolean result.

## Limitations

- The package does not provide the SketchForge web UI, HTTP routes, authentication, or a remote project client. Use the [TypeScript client](https://www.npmjs.com/package/@constructorfleet/sketchforge-client) for the REST API.
- There is no package-level `meshForShape` dispatcher yet; use the primitive builders or exact-solid helpers for the specific shape kinds they support.
- The engine reads and writes SketchForge projects through a `ProjectStore`; `directoryProjectStore` is a local filesystem implementation. It expects valid project files and a directory managed with SketchForge's project conventions.
- Parameter-only shape creation does not create drawn sketches or arbitrary mesh geometry. Import mesh data through `engine.importMesh` or use the editor for drawing workflows.
- CAD, STEP, and exact-solid operations rely on native/WASM geometry dependencies and can be more resource-intensive than pure parameter and placement helpers. Kernel-specific modules are loaded when those operations run.
- Use the package root as the supported public API. The export map also permits subpath imports for compiled modules, but undocumented internal modules are not a compatibility promise.

## License

This package is licensed under [AGPL-3.0-only](https://github.com/constructorfleet/SketchForge-3D/blob/main/LICENSE).
