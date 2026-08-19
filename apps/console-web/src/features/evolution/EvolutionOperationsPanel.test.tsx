// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { EvolutionOperationsPanel } from "./EvolutionOperationsPanel.js";
import { observedAt, testApi } from "./test-api.js";

afterEach(() => cleanup());

describe("EvolutionOperationsPanel", () => {
  it("renders all authoritative sections with localized status and raw diagnostics", async () => {
    const areas = ["COMPILE", "REVALIDATE", "REPAIR", "CODEGRAPH", "FRESHNESS", "MIGRATION", "ALERT", "INJECTION"] as const;
    render(<EvolutionOperationsPanel api={testApi({ evolutionOperations: async () => ({ schemaVersion: 1, consistency: "MIXED_REVISION", observedAt,
      sections: areas.map((area, index) => ({ area, revision: index, status: "EMPTY" as const, reasonCode: `${area}_EMPTY`, queued: 0,
        running: 0, failed: 0, updatedAt: observedAt })) }) })} />);
    expect(await screen.findByRole("heading", { name: "知识演进闭环" })).toBeTruthy();
    expect(screen.getByText("CodeGraph")).toBeTruthy(); expect(screen.getByTitle("COMPILE_EMPTY")).toBeTruthy();
  });

  it("renders consistent running state and a recoverable query failure", async () => {
    const { rerender } = render(<EvolutionOperationsPanel api={testApi({ evolutionOperations: async () => ({ schemaVersion: 1,
      consistency: "CONSISTENT", observedAt, sections: [{ area: "REVALIDATE", revision: 2, status: "RUNNING",
        reasonCode: "REVALIDATE_IN_PROGRESS", queued: 1, running: 1, failed: 0, updatedAt: observedAt }] }) })} />);
    expect(await screen.findByText("快照一致")).toBeTruthy(); expect(screen.getByText("运行中")).toBeTruthy();
    rerender(<EvolutionOperationsPanel api={testApi({ evolutionOperations: async () => { throw new Error("snapshot unavailable"); } })} />);
    expect(await screen.findByText(/snapshot unavailable/u)).toBeTruthy();
  });
});
