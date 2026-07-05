import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "./password.js";

describe("密码哈希", () => {
  it("正确密码校验通过，错误密码不通过", () => {
    const stored = hashPassword("s3cret");
    expect(stored).toContain(":");
    expect(verifyPassword("s3cret", stored)).toBe(true);
    expect(verifyPassword("wrong", stored)).toBe(false);
  });

  it("同一密码两次哈希盐不同", () => {
    expect(hashPassword("a")).not.toBe(hashPassword("a"));
  });

  it("损坏的存储格式返回 false 而不是抛错", () => {
    expect(verifyPassword("a", "garbage")).toBe(false);
  });
});
