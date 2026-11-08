import { CursorConnection } from "./cursor.js";
import {
  BUILD_FORMAT,
  reviewInstructions,
  planningInstructions,
} from "./providers.js";
import { isolatedRequest } from "./isolated-request.js";
import { CHAT_FORMAT } from "./agent-chat.js";

// A Grok worker backed by the user's Cursor subscription, never a Grok web account.
export class CursorProvider {
  constructor(
    store,
    notify = () => {},
    connection = new CursorConnection(notify, { cwd: store.directory }),
  ) {
    this.store = store;
    this.connection = connection;
  }
  get login() {
    return this.connection.login;
  }
  async selection() {
    const saved = await this.store.read("cursor-model", {});
    return {
      source: "cursor",
      modelId: typeof saved.modelId === "string" ? saved.modelId : null,
    };
  }
  async status(options) {
    return {
      ...(await this.connection.status(options)),
      ...(await this.selection()),
    };
  }
  connect(options) {
    return this.connection.connect(options);
  }
  models(options) {
    return this.connection.models(options);
  }
  async selectModel(modelId) {
    const rows = await this.models();
    if (!rows.some((row) => row.id === modelId))
      throw new Error("현재 Cursor 목록에 있는 Grok 모델을 선택하세요.");
    await this.store.write("cursor-model", { modelId });
    return this.selection();
  }
  async ready(options) {
    const selected = options?.grokRoute;
    if (
      selected?.source !== "cursor" ||
      typeof selected.modelId !== "string" ||
      !(await this.connection.status()).connected
    )
      return false;
    return (await this.models()).some((row) => row.id === selected.modelId);
  }
  async ask(instructions, context) {
    const selected = context.options?.grokRoute;
    if (selected?.source !== "cursor" || typeof selected.modelId !== "string")
      throw new Error("이 작업의 Cursor Grok 모델이 지정되지 않았습니다.");
    return isolatedRequest(context, (root, safe) =>
      this.connection.ask(
        instructions,
        { ...safe, snapshot: { ...safe.snapshot, root } },
        selected.modelId,
      ),
    );
  }
  build(context) {
    return this.ask(BUILD_FORMAT, context);
  }
  chat(context) {
    return this.ask(CHAT_FORMAT, context);
  }
  async plan(context) {
    return this.ask(await planningInstructions(undefined, context.options), context);
  }
  review(context) {
    return this.ask(reviewInstructions(context.visualComparison,context.challenge,context.renderFailure), context);
  }
  cancel() {
    this.connection.cancel();
  }
}
