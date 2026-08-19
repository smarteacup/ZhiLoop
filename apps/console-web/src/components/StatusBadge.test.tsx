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
    expect(statusLabel("EMPTY")).toBe("暂无记录");
  });

  it("falls back to an unknown protocol value without inventing a translation", () => {
    expect(statusLabel("FUTURE_STATUS")).toBe("未知状态（FUTURE_STATUS）");
  });

  it("assigns distinct tones to warning, failure, and neutral protocol values", () => {
    const { rerender } = render(<StatusBadge status="DEGRADED" />);
    expect(screen.getByText("降级").classList.contains("warning")).toBe(true);
    rerender(<StatusBadge status="FAILED" />);
    expect(screen.getByText("失败").classList.contains("bad")).toBe(true);
    rerender(<StatusBadge status="PENDING" />);
    expect(screen.getByText("等待中").classList.contains("neutral")).toBe(true);
  });
});
