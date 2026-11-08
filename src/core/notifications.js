import { randomUUID } from "node:crypto";
import { redact } from "./secrets.js";
const actions = new Set([
  "workflow",
  "design",
  "settings",
  "connections",
  "checkpoints",
  "delivery",
  "questions",
  "prerequisites",
]);
export class NotificationInbox {
  constructor(store) {
    this.store = store;
    this.queue = Promise.resolve();
  }
  async list() {
    return (await this.store.read("notifications", { items: [] })).items.slice(
      0,
      200,
    );
  }
  change(operation) {
    const next = this.queue.then(async () => {
      const state = await this.store.read("notifications", {
        items: [],
        seenKeys: [],
      });
      const items = state.items.slice(0, 200);
      state.seenKeys = [
        ...new Set([
          ...(state.seenKeys ?? []),
          ...items.map((item) => item.key).filter(Boolean),
        ]),
      ].slice(-1000);
      const value = await operation(items, state);
      await this.store.write("notifications", {
        items: value.slice(0, 200),
        seenKeys: state.seenKeys.slice(-1000),
      });
      return value.slice(0, 200);
    });
    this.queue = next.catch(() => {});
    return next;
  }
  add(value) {
    if (
      !value ||
      typeof value.message !== "string" ||
      !value.message.trim() ||
      value.message.length > 3000
    )
      throw new Error("알림 내용을 확인하세요.");
    return this.change((items, state) => {
      const key =
        typeof value.key === "string"
          ? redact(value.key).slice(0, 200)
          : undefined;
      const entry = {
        id: randomUUID(),
        at: new Date().toISOString(),
        message: redact(value.message).slice(0, 1000),
        type: ["error", "success"].includes(value.type) ? value.type : "info",
        read: false,
        ...(key ? { key } : {}),
        ...(actions.has(value.action) ? { action: value.action } : {}),
        ...(typeof value.projectId === "string" && value.projectId.length < 80
          ? { projectId: value.projectId }
          : {}),
        ...(typeof value.conversationId === "string" &&
        value.conversationId.length < 80
          ? { conversationId: value.conversationId }
          : {}),
      };
      if (key && state.seenKeys.includes(key)) return items;
      if (key) state.seenKeys.push(key);
      return [entry, ...items];
    });
  }
  remove(id) {
    if (typeof id !== "string" || id.length > 80)
      throw new Error("알림 ID를 확인하세요.");
    return this.change((items) => items.filter((item) => item.id !== id));
  }
  clear() {
    return this.change(() => []);
  }
  markRead() {
    return this.change((items) =>
      items.map((item) => ({ ...item, read: true })),
    );
  }
}
