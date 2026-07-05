import { describe, expect, it } from "vitest";
import { redactSecrets } from "./redact.js";

describe("redactSecrets", () => {
  it("把出现的密钥替换为 ***", () => {
    const token = "glpat-abc123XYZ";
    const text = `fatal: unable to access 'https://oauth2:${token}@git.internal/g/d.git/'`;
    const out = redactSecrets(text, [token]);
    expect(out).not.toContain(token);
    expect(out).toContain("***");
  });

  it("替换全部出现，不止第一次", () => {
    const t = "SECRET";
    expect(redactSecrets("SECRET x SECRET", [t])).toBe("*** x ***");
  });

  it("忽略空密钥，避免把整串打成星号", () => {
    expect(redactSecrets("abc", ["", "  "])).toBe("abc");
  });

  it("同时脱敏多个密钥", () => {
    expect(redactSecrets("a=A b=B", ["A", "B"])).toBe("a=*** b=***");
  });

  it("密钥含正则元字符时按字面量处理", () => {
    const t = "a.b+c(d)";
    expect(redactSecrets(`x ${t} y`, [t])).toBe("x *** y");
  });
});
