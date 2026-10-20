import { describe, expect, it } from "vitest";
import { NOTE_MAX_BYTES, NOTE_TITLE_MAX, formatNoteSize, utf8ByteLength } from "@/components/notes/limits";
import { noteExcerpt, noteIdSchema, noteInputSchema, notePreviewSchema, noteUpdateSchema } from "@/components/notes/note-schema";

describe("noteInputSchema", () => {
  it("accepts a minimal note and normalises optional fields to null", () => {
    expect(noteInputSchema.parse({ contentMd: "hello" })).toEqual({ title: null, contentMd: "hello", problemId: null });
    expect(noteInputSchema.parse({ title: "   ", contentMd: "x", problemId: "" })).toEqual({
      title: null,
      contentMd: "x",
      problemId: null,
    });
  });

  it("cleans the title to one line and caps it", () => {
    expect(noteInputSchema.parse({ title: "  Two\tpointers\n trick​ ", contentMd: "x" }).title).toBe("Two pointers trick");
    expect(noteInputSchema.safeParse({ title: "t".repeat(NOTE_TITLE_MAX), contentMd: "x" }).success).toBe(true);
    expect(noteInputSchema.safeParse({ title: "t".repeat(NOTE_TITLE_MAX + 1), contentMd: "x" }).success).toBe(false);
  });

  it("requires content and normalises line endings", () => {
    expect(noteInputSchema.safeParse({ contentMd: "" }).success).toBe(false);
    expect(noteInputSchema.safeParse({ contentMd: " \n\t " }).success).toBe(false);
    expect(noteInputSchema.safeParse({}).success).toBe(false);
    expect(noteInputSchema.parse({ contentMd: "a\r\nb\rc" }).contentMd).toBe("a\nb\nc");
  });

  it("caps content at 64 KB of UTF-8, not 64 K characters", () => {
    expect(NOTE_MAX_BYTES).toBe(65_536);
    expect(noteInputSchema.safeParse({ contentMd: "a".repeat(NOTE_MAX_BYTES) }).success).toBe(true);
    expect(noteInputSchema.safeParse({ contentMd: "a".repeat(NOTE_MAX_BYTES + 1) }).success).toBe(false);
    // "த" (Tamil) is 3 bytes in UTF-8: 21,846 of them exceed 64 KB.
    const tamil = "த".repeat(Math.floor(NOTE_MAX_BYTES / 3) + 1);
    expect(tamil.length).toBeLessThan(NOTE_MAX_BYTES);
    expect(noteInputSchema.safeParse({ contentMd: tamil }).success).toBe(false);
  });

  it("validates the problem id shape", () => {
    expect(noteInputSchema.parse({ contentMd: "x", problemId: "clx9abc" }).problemId).toBe("clx9abc");
    expect(noteInputSchema.safeParse({ contentMd: "x", problemId: "../etc" }).success).toBe(false);
    expect(noteInputSchema.safeParse({ contentMd: "x", problemId: "p".repeat(65) }).success).toBe(false);
  });

  it("requires an id-shaped id for updates", () => {
    expect(noteUpdateSchema.safeParse({ id: "clx1", contentMd: "x" }).success).toBe(true);
    expect(noteUpdateSchema.safeParse({ contentMd: "x" }).success).toBe(false);
    expect(noteIdSchema.safeParse("a b").success).toBe(false);
    expect(noteIdSchema.safeParse("").success).toBe(false);
  });

  it("previews accept empty text but not oversized text", () => {
    expect(notePreviewSchema.safeParse({ contentMd: "" }).success).toBe(true);
    expect(notePreviewSchema.safeParse({ contentMd: "a".repeat(NOTE_MAX_BYTES + 1) }).success).toBe(false);
  });
});

describe("note helpers", () => {
  it("measures UTF-8 bytes", () => {
    expect(utf8ByteLength("abc")).toBe(3);
    expect(utf8ByteLength("த")).toBe(3);
    expect(utf8ByteLength("😀")).toBe(4);
  });

  it("formats the size counter", () => {
    expect(formatNoteSize(0)).toBe("0.0 KB of 64 KB");
    expect(formatNoteSize(1536)).toBe("1.5 KB of 64 KB");
    expect(formatNoteSize(40 * 1024)).toBe("40 KB of 64 KB");
  });

  it("makes a plain-text excerpt from Markdown", () => {
    const md = "## Idea\n\nUse **two pointers** and a [hash map](https://x.example).\n\n```cpp\nint main() {}\n```\n- left\n- right <b>bold</b>";
    expect(noteExcerpt(md)).toBe("Idea Use two pointers and a hash map. left right bold");
    const long = noteExcerpt("word ".repeat(100), 20);
    expect(Array.from(long)).toHaveLength(20);
    expect(long.endsWith("…")).toBe(true);
  });
});
