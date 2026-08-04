// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { StatusBadge, statusLabel } from "./StatusBadge.js";

afterEach(() => cleanup());

describe("StatusBadge", () => {
  it("renders protocol statuses in Chinese while preserving the raw value for diagnostics", () => {
    render(<StatusBadge status="CAPTURED_CURRENT" />);
    const badge = screen.getByText("已采集至最新");
    expect(badge.getAttribute("title")).toBe("CAPTURED_CURRENT");
    expect(statusLabel("CAPTURED_PARTIAL")).toBe("部分采集");
  });

  it("falls back to an unknown protocol value without inventing a translation", () => {
    expect(statusLabel("FUTURE_STATUS")).toBe("FUTURE_STATUS");
  });
});
