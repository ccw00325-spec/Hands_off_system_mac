import { randomUUID } from "node:crypto";
import { inheritedTeam, roleSummary } from './team-memory.js';
export class Projects {
  constructor(store) {
    this.store = store;
    this.queue = Promise.resolve();
  }
  async list() {
    let data = await this.store.read("projects", null);
    if (!data) {
      const project = {
        id: randomUUID(),
        title: "새 프로젝트",
        createdAt: new Date().toISOString(),
      };
      data = { activeId: project.id, items: [project] };
      await this.store.write("projects", data);
    }
    return data;
  }
  mutate(fn) {
    const operation = this.queue.then(async () => {
      const data = await this.list();
      await fn(data);
      await this.store.write("projects", data);
      return data;
    });
    this.queue = operation.catch(() => {});
    return operation;
  }
  create(title, workspace = null) {
    return this.mutate((data) => {
      if (
        workspace &&
        data.items.some((item) => item.workspace?.root === workspace.root)
      )
        throw new Error(
          "이 폴더는 이미 프로젝트에 연결되어 있습니다. 왼쪽에서 해당 프로젝트를 선택하세요.",
        );
      const project = {
        id: randomUUID(),
        title: this.title(title),
        createdAt: new Date().toISOString(),
        ...(workspace ? { workspace } : {}),
      };
      const team = inheritedTeam(data);
      if (team) { project.team = team; project.roles = roleSummary(team); }
      data.items.push(project);
      data.activeId = project.id;
    });
  }
  rename(id, title) {
    return this.mutate((data) => {
      this.find(data, id).title = this.title(title);
    });
  }
  select(id) {
    return this.mutate((data) => {
      this.find(data, id);
      data.activeId = id;
    });
  }
  grant(id, workspace) {
    return this.mutate((data) => {
      if (
        data.items.some(
          (item) => item.id !== id && item.workspace?.root === workspace.root,
        )
      )
        throw new Error("이 폴더는 다른 프로젝트에 연결되어 있습니다.");
      this.find(data, id).workspace = workspace;
    });
  }
  revoke(id) {
    return this.mutate((data) => {
      delete this.find(data, id).workspace;
    });
  }
  find(data, id) {
    const project = data.items.find((item) => item.id === id);
    if (!project) throw new Error("프로젝트를 찾지 못했습니다.");
    return project;
  }
  title(value) {
    if (typeof value !== "string" || !value.trim() || value.length > 80)
      throw new Error("프로젝트 제목을 1~80자로 입력하세요.");
    return value.trim();
  }
}
