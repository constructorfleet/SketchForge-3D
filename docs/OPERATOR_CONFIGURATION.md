# Operator configuration

This reference covers public settings for server and container operators. Build, test, development, and internal runtime flags are intentionally excluded. The registry is maintained in `packages/sketchforge-engine/src/support/lib/operator-configuration.json`; regenerate this page with `node scripts/generate-operator-configuration.mjs`.

`required` means required to enable the described optional feature; no setting is required for the application to start with its default behavior.

| Name | Default | Required | Validation and behavior | Sensitive | Owning subsystem |
| --- | --- | --- | --- | --- | --- |
| `SKETCHFORGE_PORT` | 3000 | No | Compose host port published to container port 3000; configure this when host port 3000 is already occupied. | No | Docker port publishing |
| `SKETCHFORGE_SHARED_PROJECTS_VOLUME` | sketchforge-shared-projects | No | Docker named volume or bind mount source for /data/projects, where shared project files are stored. | No | Docker shared project persistence |
| `SKETCHFORGE_PROJECTS_VOLUME` | sketchforge-projects | No | Docker named volume or bind mount source for /data/my-projects. Used when SKETCHFORGE_PROJECTS_DIR points to that path. | No | Docker server project persistence |
| `PORT` | 3000 | No | Integer from 1 through 65535; invalid values fall back to 3000. | No | Docker server listener |
| `HOSTNAME` | 0.0.0.0 in the Docker launcher; otherwise supplied by the hosting runtime. | No | Passed to the Next.js server as its bind host. | No | Docker server listener |
| `SKETCHFORGE_LEGACY_PORT` | 80 | No | Integer from 1 through 65535; invalid values fall back to 80. Set equal to PORT to disable the compatibility proxy. | No | Docker compatibility proxy |
| `SKETCHFORGE_PROJECTS_DIR` | Unset; browser-local storage is used. | No | Filesystem path writable by the server. Enables server-backed project storage and must be paired with SKETCHFORGE_API_TOKEN to enable the scripting REST API. | No | Server project storage and REST API |
| `SKETCHFORGE_API_TOKEN` | Unset; REST API authorization is disabled. | No | Non-empty bearer token. Configure a high-entropy secret; never expose it to browsers or logs. Used with SKETCHFORGE_PROJECTS_DIR. | Yes | REST API authentication |
| `SKETCHFORGE_SHARED_PROJECTS_DIR` | /data/projects in the Docker image and compose examples. | No | Filesystem path writable by the server; mount persistent storage at this path to retain shared projects across container replacement. | No | Shared project files |
| `SKETCHFORGE_APP_VERSION` | Detected from the installed package or project metadata. | No | Semantic version; invalid values are ignored. | No | Update status |
| `SKETCHFORGE_UPDATE_MANIFEST_URL` | Official SketchForge release manifest URL. | No | HTTP or HTTPS URL returning JSON with a semantic-version `version` field. | No | Update status |
| `SKETCHFORGE_UPDATE_GUIDE_URL` | Official SketchForge update guide URL. | No | URL shown to users as the update guide. | No | Update status |
| `SKETCHFORGE_UPDATE_TRIGGER_URL` | Unset; server-triggered updates are unavailable. | No | HTTP or HTTPS URL for the configured update trigger endpoint. | No | Server-triggered updates |
| `SKETCHFORGE_UPDATE_ADMIN_KEY` | Unset; server-triggered updates are unavailable. | No | Secret expected by the update trigger service. Required with SKETCHFORGE_UPDATE_TRIGGER_URL. | Yes | Server-triggered updates |
| `SKETCHFORGE_UPDATE_TRIGGER_TOKEN` | Unset; trigger requests are unauthorized. | No | Secret bearer token sent to the configured trigger endpoint. Required when that endpoint enforces a trigger token. | Yes | Server-triggered updates |

## Scope and limitations

Compose uses `SKETCHFORGE_PORT` to choose the host port published to container port 3000. The Docker launcher currently validates `PORT` and `SKETCHFORGE_LEGACY_PORT`; invalid values fall back to their listed defaults. Other path and URL settings are validated or interpreted by their owning subsystem at runtime as described above. Keep secrets in the deployment secret store and avoid printing them in logs.

The reference covers supported public server/container configuration found in the current readers and deployment examples. It does not claim to inventory every environment variable used by build tooling, tests, desktop development, or the browser editor.
