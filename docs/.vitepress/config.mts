import { execFileSync } from "node:child_process";
import { defineConfig } from "vitepress";

function repositoryName() {
  const configured = process.env.GITHUB_REPOSITORY;
  if (configured) return configured.split("/").at(-1)!;

  const remote = execFileSync("git", ["remote", "get-url", "origin"], { encoding: "utf8" }).trim();
  const match = remote.match(/(?:github\.com[:/])[^/]+\/([^/.]+?)(?:\.git)?$/);
  if (!match) throw new Error(`Cannot derive Pages repository path from origin: ${remote}`);
  return match[1];
}

const base = `/${repositoryName()}/`;

export default defineConfig({
  title: "SketchForge Docs",
  description: "User, developer, and API documentation for SketchForge.",
  base,
  outDir: "../docs-site-dist",
  cleanUrls: true,
  lastUpdated: true,
  head: [["link", { rel: "icon", href: `${base}favicon.svg` }]],
  themeConfig: {
    nav: [
      { text: "Learn", link: "/" },
      { text: "REST API", link: "/docs/REST_API" },
      { text: "Project format", link: "/docs/SKF_PROJECT_FORMAT" },
      { text: "Clients", link: "/docs/PUBLISHING_CLIENTS" },
      { text: "References", link: "/docs/reference/typescript-client" },
      { text: "Migration map", link: "/docs/site-migration" },
    ],
    sidebar: [
      {
        text: "Documentation",
        items: [
          { text: "Overview", link: "/" },
          { text: "REST API", link: "/docs/REST_API" },
          { text: ".skf project format", link: "/docs/SKF_PROJECT_FORMAT" },
          { text: "Publishing clients", link: "/docs/PUBLISHING_CLIENTS" },
          { text: "Translations", link: "/docs/TRANSLATIONS" },
          { text: "Capability gaps", link: "/docs/UNEXPLORED_KERNEL_CAPABILITIES" },
          { text: "Documentation suite plan", link: "/docs/DOCUMENTATION_SUITE_SPEC" },
          { text: "Migration map", link: "/docs/site-migration" },
        ],
      },
      {
        text: "Packages",
        items: [
          { text: "TypeScript client", link: "/docs/packages/typescript-client" },
          { text: "Engine", link: "/docs/packages/engine" },
          { text: "Python client", link: "/docs/packages/python-client" },
        ],
      },
      {
        text: "Generated references",
        items: [
          { text: "TypeScript client API", link: "/docs/reference/typescript-client" },
          { text: "Engine API", link: "/docs/reference/typescript-engine" },
          { text: "Python API", link: "/docs/reference/python-client" },
          { text: "Shape requests", link: "/docs/SHAPE_REQUEST_REFERENCE" },
        ],
      },
    ],
    search: { provider: "local" },
    socialLinks: [{ icon: "github", link: "https://github.com/constructorfleet/SketchForge-3D" }],
  },
});
