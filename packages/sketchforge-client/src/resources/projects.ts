import type { Transport } from "../http.js";
import type { DeleteResult, ListPage, ListPageOptions, ProjectDetail, ProjectSummary } from "../types.js";

export class Projects {
  constructor(private readonly transport: Transport) {}

  async list(): Promise<ProjectSummary[]> {
    const payload = await this.transport.send<{ projects: ProjectSummary[] }>({
      method: "GET",
      path: "/projects",
    });
    return payload.projects;
  }

  async listPage(options: ListPageOptions = {}): Promise<ListPage<ProjectSummary>> {
    const payload = await this.transport.send<{ projects: ProjectSummary[]; nextCursor: string | null }>({
      method: "GET",
      path: "/projects",
      query: { ...(options.limit === undefined ? {} : { limit: String(options.limit) }), ...(options.cursor ? { cursor: options.cursor } : {}) },
    });
    return { items: payload.projects, nextCursor: payload.nextCursor };
  }

  async get(projectId: string): Promise<ProjectDetail> {
    const payload = await this.transport.send<{ project: ProjectDetail }>({
      method: "GET",
      path: "/projects",
      query: { projectId },
    });
    return payload.project;
  }

  /** The server truncates a name to 80 characters and refuses an empty one. */
  async create(name: string): Promise<ProjectSummary> {
    const payload = await this.transport.send<{ project: ProjectSummary }>({
      method: "POST",
      path: "/projects",
      body: { name },
      retryable: true,
    });
    return payload.project;
  }

  async delete(projectId: string): Promise<DeleteResult> {
    return this.transport.send<DeleteResult>({
      method: "DELETE",
      path: "/projects",
      query: { projectId },
      retryable: true,
    });
  }

  /** The first project with this name, or null. Names are not unique server-side. */
  async findByName(name: string): Promise<ProjectSummary | null> {
    const projects = await this.list();
    return projects.find((project) => project.name === name) ?? null;
  }
}
