import { describe, expect, it } from "vitest";
import { InMemorySessionStore } from "@byte-mentor/session";
import { runStoreContractTests, validCreateInput } from "./store-contract.js";

// InMemory 实现注册同一份 Store contract 测试：与 SQLite 共享全部生命周期断言。
describe("InMemorySessionStore contract", () => {
  runStoreContractTests({
    label: "in-memory",
    async create() {
      return new InMemorySessionStore();
    },
    async close(store) {
      await store.close();
    },
  });
});

// InMemory 实现的基础生命周期：createSession 输入与 loadSession 返回互相一致。
describe("InMemorySessionStore lifecycle", () => {
  it("createSession input is fully reflected in loadSession", async () => {
    const store = new InMemorySessionStore();
    const created = await store.createSession(validCreateInput);
    const loaded = await store.loadSession(created.id);
    expect(loaded).toEqual(created);
  });
});
