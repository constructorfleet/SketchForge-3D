# Deployment configuration

This guide covers the server and container settings operators can configure. For a complete list of supported values, defaults, sensitivity, source readers, and owning pages, see the [operator configuration reference](../OPERATOR_CONFIGURATION.md). The [Docker / FabLab Server instructions](https://github.com/constructorfleet/SketchForge-3D#docker-fablab-server-recommended) cover initial setup and compose commands.

## Docker listener

The compose files publish container port `3000` on host port `3000` by default. Set `SKETCHFORGE_PORT` to change the host port. Inside the container, `PORT` selects the Next.js listener port, `HOSTNAME` selects its bind address, and `SKETCHFORGE_LEGACY_PORT` selects the compatibility proxy port (`80` by default). The launcher accepts ports from 1 through 65535 and falls back to its documented default for invalid values. Set the legacy port equal to `PORT` to disable the compatibility proxy. See the [port configuration example](https://github.com/constructorfleet/SketchForge-3D#use-a-different-port).

## Server-backed projects

Set `SKETCHFORGE_PROJECTS_DIR` to a writable persistent directory to store a user's projects on the server instead of in browser-local storage. The Docker compose configuration maps `/data/my-projects` to the `sketchforge-projects` volume by default; `SKETCHFORGE_PROJECTS_VOLUME` changes that volume or bind-mount source. See [server-side project storage](https://github.com/constructorfleet/SketchForge-3D#server-side-project-storage) for migration and persistence behavior.

## REST API access

Set `SKETCHFORGE_API_TOKEN` together with `SKETCHFORGE_PROJECTS_DIR` to enable authenticated REST API access. Treat the token as a secret: use a high-entropy value, store it in the deployment's secret manager, and keep it out of browser code and logs. See the [REST API deployment instructions](https://github.com/constructorfleet/SketchForge-3D#rest-api).

## Shared projects

The Docker image stores shared projects at `/data/projects` by default. Set `SKETCHFORGE_SHARED_PROJECTS_DIR` to change the path, and mount persistent storage there. The default compose volume is `sketchforge-shared-projects`; set `SKETCHFORGE_SHARED_PROJECTS_VOLUME` to choose another named volume or bind-mount source. See [shared Docker projects](https://github.com/constructorfleet/SketchForge-3D#shared-docker-projects).

