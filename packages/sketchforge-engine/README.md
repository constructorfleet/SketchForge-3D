# SketchForge engine

The package owns SketchForge's shape model, project format, geometry operations, and filesystem-backed project store. The web app and local MCP both use this implementation.

Build it from the repository root with `npm run engine:build`. It emits Node ESM and TypeScript declarations under `dist/`. Node consumers need Node 20 or newer. Kernel modules load only when a CAD or STEP operation needs them; the package selects the staged browser kernel in a browser and the Node package loader in Node.

The package is currently repository-local and unpublished. It is licensed under AGPL-3.0-only.
