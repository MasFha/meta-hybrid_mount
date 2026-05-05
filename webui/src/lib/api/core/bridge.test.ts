import { describe, expect, it } from "vitest";
import { AppError } from "./error";
import { parseHybridMountJsonOutput, shouldUseMock } from "./bridge";

describe("parseHybridMountJsonOutput", () => {
  it("only enables the mock API in test mode", () => {
    expect(shouldUseMock).toBe(true);
  });

  it("parses valid JSON payloads", () => {
    expect(parseHybridMountJsonOutput('{"storage_mode":"tmpfs"}')).toEqual({
      storage_mode: "tmpfs",
    });
  });

  it("parses daemon config payloads", () => {
    expect(
      parseHybridMountJsonOutput(
        '{"moduledir":"/data/adb/modules","partitions":[]}',
      ),
    ).toEqual({
      moduledir: "/data/adb/modules",
      partitions: [],
    });
  });

  it("throws structured CLI error payloads", () => {
    expect(() =>
      parseHybridMountJsonOutput(
        '{"type":"error","error":"Failed to connect to daemon socket"}',
      ),
    ).toThrow(AppError);
  });

  it("throws daemon response error payloads", () => {
    expect(() =>
      parseHybridMountJsonOutput(
        '{"ok":false,"error":"daemon request failed"}',
      ),
    ).toThrow("daemon request failed");
  });
});
