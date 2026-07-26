// Model list table tests cover terminal table rendering for model list output.
import { describe, expect, it, vi } from "vitest";
import { printModelTable } from "./list.table.js";
import type { ModelRow } from "./list.types.js";

describe("printModelTable", () => {
  it("prints an empty model list as valid structured JSON", () => {
    const runtime = { log: vi.fn(), error: vi.fn() };

    printModelTable([], runtime as never, { json: true });

    expect(runtime.log).toHaveBeenCalledTimes(1);
    expect(JSON.parse(runtime.log.mock.calls[0]![0] as string)).toEqual({
      count: 0,
      models: [],
    });
  });

  it("keeps an empty plain model list silent", () => {
    const runtime = { log: vi.fn(), error: vi.fn() };

    printModelTable([], runtime as never, { plain: true });

    expect(runtime.log).not.toHaveBeenCalled();
  });

  it("prints effective and native context values when a runtime cap differs", () => {
    const runtime = { log: vi.fn(), error: vi.fn() };
    const rows: ModelRow[] = [
      {
        key: "openai/gpt-5.5",
        name: "GPT-5.5",
        input: "text+image",
        contextWindow: 400_000,
        contextTokens: 272_000,
        local: false,
        available: true,
        tags: [],
        missing: false,
      },
    ];

    printModelTable(rows, runtime as never);

    // Decimal windows render in decimal K: 272000 -> "272k", 400000 -> "400k".
    expect(runtime.log.mock.calls).toEqual([
      ["Model                                      Input      Ctx         Local Auth  Tags"],
      ["openai/gpt-5.5                             text+image 272k/400k   no    yes   "],
    ]);
  });
});
