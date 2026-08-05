import { describe, expect, it } from "vitest";
import { applyEdits } from "@byte-mentor/agent";

describe("applyEdits exact matching", () => {
  // 单个唯一目标在 LF 空间精确替换，输出恢复原始换行并报告替换数与首个变化行。
  it("replaces a single unique occurrence", () => {
    const result = applyEdits("const a = 1;\nconst b = 2;\n", [
      { oldText: "const a = 1;", newText: "const a = 10;" },
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.text).toBe("const a = 10;\nconst b = 2;\n");
      expect(result.replacements).toBe(1);
      expect(result.firstChangedLine).toBe(1);
    }
  });

  // 同一文件内多个不相交目标一次全部替换，互不影响彼此结果。
  it("applies multiple non-overlapping edits", () => {
    const result = applyEdits("const a = 1;\nconst b = 2;\n", [
      { oldText: "const a = 1;", newText: "const a = 10;" },
      { oldText: "const b = 2;", newText: "const b = 20;" },
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.text).toBe("const a = 10;\nconst b = 20;\n");
      expect(result.replacements).toBe(2);
    }
  });

  // 后一个 edit 匹配原始快照而非前一个替换的结果，前一个 newText 不会成为后一个的输入。
  it("matches later edits against the original snapshot", () => {
    const result = applyEdits("first\nconst a = 1;\n", [
      { oldText: "first", newText: "const a = 1;" },
      { oldText: "const a = 1;", newText: "changed" },
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.text).toBe("const a = 1;\nchanged\n");
    }
  });

  // 目标没有出现时整次调用失败，并指出对应的 editIndex。
  it("fails when a target is missing", () => {
    const result = applyEdits("a\nb\n", [{ oldText: "nope", newText: "x" }]);
    expect(result).toMatchObject({
      ok: false,
      error: { code: "edit_target_not_found", editIndex: 0 },
    });
  });

  // 目标出现多次时失败，occurrences 记录实际出现次数以提示增加上下文。
  it("fails when a target appears multiple times", () => {
    const result = applyEdits("dup\ndup\n", [{ oldText: "dup", newText: "x" }]);
    expect(result).toMatchObject({
      ok: false,
      error: { code: "edit_target_not_unique", editIndex: 0, occurrences: 2 },
    });
  });

  // 出现次数统计必须包含相互重叠的候选，aa 在 aaa 中出现两次。
  it("counts overlapping candidates", () => {
    const result = applyEdits("aaa", [{ oldText: "aa", newText: "x" }]);
    expect(result).toMatchObject({
      ok: false,
      error: { code: "edit_target_not_unique", editIndex: 0, occurrences: 2 },
    });
  });

  // 两个替换范围重叠或嵌套时整次调用失败，提示模型合并对应 edit。
  it("fails when two targets overlap or nest", () => {
    const result = applyEdits("abc", [
      { oldText: "abc", newText: "z" },
      { oldText: "b", newText: "y" },
    ]);
    expect(result).toMatchObject({ ok: false, error: { code: "edit_targets_overlap" } });
  });

  // 替换计算后内容与原内容相同视为虚假成功，应返回 edit_no_change。
  it("fails when the replacement leaves the file unchanged", () => {
    const result = applyEdits("a\nb\n", [{ oldText: "a", newText: "a" }]);
    expect(result).toMatchObject({ ok: false, error: { code: "edit_no_change" } });
  });

  // 空 newText 且 oldText 含行尾换行时删除整个目标行，其余行保持原样。
  it("deletes the target with an empty newText", () => {
    const result = applyEdits("keep\nremove\n", [{ oldText: "remove\n", newText: "" }]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.text).toBe("keep\n");
    }
  });
});

describe("applyEdits newline handling", () => {
  // CRLF 文件修改后其余行与修改行都恢复 CRLF，不被整体改写为 LF。
  it("restores CRLF newlines", () => {
    const result = applyEdits("one\r\ntwo\r\n", [{ oldText: "two", newText: "TWO" }]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.text).toBe("one\r\nTWO\r\n");
    }
  });

  // 纯 CR 文件同样支持，修改行恢复 CR 风格。
  it("restores CR newlines", () => {
    const result = applyEdits("one\rtwo\r", [{ oldText: "two", newText: "TWO" }]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.text).toBe("one\rTWO\r");
    }
  });

  // 混合换行文件以最先检测到的有效换行作为恢复目标，未触及行保持各自原始换行。
  it("detects the first newline style in mixed files", () => {
    const result = applyEdits("one\r\ntwo\nthree\r\n", [{ oldText: "two", newText: "TWO" }]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.text).toBe("one\r\nTWO\r\nthree\r\n");
    }
  });

  // 跨行目标替换为含换行的 newText 时，行块整体重建且行数变化正确。
  it("replaces a block spanning multiple lines", () => {
    const result = applyEdits("a\nb\nc\n", [{ oldText: "a\nb", newText: "X\nY" }]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.text).toBe("X\nY\nc\n");
    }
  });
});

describe("applyEdits fuzzy matching", () => {
  // 精确匹配唯一时优先使用精确空间，即使模糊等价文本存在于其他行也不干扰。
  it("matches precisely before falling back to fuzzy", () => {
    const result = applyEdits("it\u2019s\nit's\n", [{ oldText: "it's", newText: "ITS" }]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.text).toBe("it\u2019s\nITS\n");
    }
  });

  // NFKC 归一化吸收全角/半角差异，模糊匹配仍能命中。
  it("normalizes NFKC full-width characters", () => {
    const result = applyEdits("Ｈｅｌｌｏ\n", [{ oldText: "Hello", newText: "Hi" }]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.text).toBe("Hi\n");
    }
  });

  // 智能单双引号归一化为 ASCII 引号后匹配成功。
  it("normalizes smart quotes", () => {
    const result = applyEdits("it\u2019s a test\n", [{ oldText: "it's", newText: "ITS" }]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.text).toBe("ITS a test\n");
    }
  });

  // 常见 Unicode dash 归一化为 ASCII 连字符后匹配成功。
  it("normalizes dashes", () => {
    const result = applyEdits("a \u2014 b\n", [{ oldText: "a - b", newText: "A-B" }]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.text).toBe("A-B\n");
    }
  });

  // 常见特殊空格归一化为普通空格后匹配成功。
  it("normalizes special spaces", () => {
    const result = applyEdits("a\u00A0b\n", [{ oldText: "a b", newText: "ab" }]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.text).toBe("ab\n");
    }
  });

  // oldText 的尾部空白在归一化后被去除，仍能命中文件中无尾随空白的行。
  it("strips trailing whitespace before matching", () => {
    const result = applyEdits("bar\n", [{ oldText: "bar  ", newText: "BAR" }]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.text).toBe("BAR\n");
    }
  });

  // 任一 edit 需要模糊匹配时，全部 edit 都在同一个模糊空间重新定位。
  it("uses a single fuzzy space for every edit when one requires fuzz", () => {
    const result = applyEdits("foo\u2019\nbar  \n", [
      { oldText: "foo'", newText: "F" },
      { oldText: "bar", newText: "B" },
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.text).toBe("F\nB\n");
    }
  });

  // 模糊匹配只重建受影响行块，未触及行从原始文本复制，避免全文被归一化。
  it("preserves untouched lines exactly under fuzzy matching", () => {
    const source = "smart\u2019quotes\nstill\u2019smart\n";
    const result = applyEdits(source, [{ oldText: "smart'quotes", newText: "S" }]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.text).toBe("S\nstill\u2019smart\n");
    }
  });
});

describe("applyEdits diff and patch", () => {
  // 展示 diff 带行号与有限上下文，精确记录移除、新增和上下文行。
  it("generates a display diff with line numbers", () => {
    const result = applyEdits("line one\nline two\nline three\n", [
      { oldText: "line two", newText: "line TWO" },
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.diff).toBe(
        "@@ -1,3 +1,3 @@\n 1 | line one\n-2 | line two\n+2 | line TWO\n 3 | line three",
      );
    }
  });

  // unified patch 使用标准 hunk 头，模型可据此准确理解最终修改。
  it("generates a unified patch", () => {
    const result = applyEdits("line one\nline two\nline three\n", [
      { oldText: "line two", newText: "line TWO" },
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.patch).toContain("@@ -1,3 +1,3 @@");
      expect(result.patch).toContain("-line two");
      expect(result.patch).toContain("+line TWO");
    }
  });

  // 文件中部内容变化时，首个变化行号指向真实修改位置。
  it("reports the first changed line", () => {
    const result = applyEdits("a\nb\nc\n", [{ oldText: "c", newText: "C" }]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.firstChangedLine).toBe(3);
    }
  });
});
