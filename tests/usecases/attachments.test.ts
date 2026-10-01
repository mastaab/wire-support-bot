import { describe, it, expect } from "vitest";
import {
  ATTACHMENT_MAX_BYTES, attachableKind, attachmentComment, describeFile, formatAttachQuestion,
} from "../../src/application/services/attachments";

describe("attachableKind", () => {
  it.each(["image/jpeg", "image/png", "image/heic", "image/heif", "image/webp"])("treats %s as a photo", (type) => {
    expect(attachableKind(type)).toBe("photo");
  });

  it.each([
    "application/pdf",
    "text/plain",
    "text/csv",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ])("treats %s as a file", (type) => {
    expect(attachableKind(type)).toBe("file");
  });

  it.each([
    ["image/jpeg; charset=x", "photo"],
    ["text/plain; charset=utf-8", "file"],
    ["  application/pdf ;name=x.pdf", "file"],
    ["IMAGE/JPEG", "photo"],
    ["Image/Png", "photo"],
    ["Application/PDF", "file"],
  ])("normalises %j to %s", (type, kind) => {
    expect(attachableKind(type)).toBe(kind);
  });

  it.each([
    "application/zip",
    "application/x-zip-compressed",
    "application/x-msdownload",
    "application/x-msdos-program",
    "application/octet-stream",
    "video/mp4",
    "video/quicktime",
    "image/svg+xml",
    "image/gif",
    "text/html",
    "application/msword",
    "",
    ";",
  ])("rejects %j", (type) => {
    expect(attachableKind(type)).toBeNull();
  });
});

describe("attachment texts", () => {
  it("limits attachments to 10 MB", () => {
    expect(ATTACHMENT_MAX_BYTES).toBe(10 * 1024 * 1024);
  });

  it("describes a photo without its name and a file with it", () => {
    expect(describeFile({ fileKind: "photo", name: "IMG_0001.jpg" })).toBe("this photo");
    expect(describeFile({ fileKind: "file", name: "report.pdf" })).toBe("this file (report.pdf)");
  });

  it("asks about a photo with the key and summary, then (yes or no)?", () => {
    expect(formatAttachQuestion("SD-16", "Error light on printer 12", { fileKind: "photo", name: "IMG_0001.jpg" }))
      .toBe('Shall I add this photo to **SD-16** "Error light on printer 12"?\n\n(yes or no)?');
  });

  it("asks about a document by name and collapses whitespace in the summary", () => {
    expect(formatAttachQuestion("SD-16", "  Error\n light   on printer 12 ", { fileKind: "file", name: "service log.pdf" }))
      .toBe('Shall I add this file (service log.pdf) to **SD-16** "Error light on printer 12"?\n\n(yes or no)?');
  });

  it.each([
    ["photo", "Alice", "Photo from Wire, sent by Alice. Sent from Wire."],
    ["file", "Alice", "File from Wire, sent by Alice. Sent from Wire."],
    ["photo", "  Bob  ", "Photo from Wire, sent by Bob. Sent from Wire."],
    ["photo", undefined, "Photo from Wire. Sent from Wire."],
    ["file", "   ", "File from Wire. Sent from Wire."],
  ] as const)("writes the %s comment for sender %j", (fileKind, senderName, comment) => {
    expect(attachmentComment({ fileKind }, senderName)).toBe(comment);
  });
});
