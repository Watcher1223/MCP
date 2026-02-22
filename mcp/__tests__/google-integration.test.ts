import { describe, it, expect } from "vitest";
import { extractTextFromGmailPayload } from "../tools/google-integration.js";

/** Helper: base64url-encode a plain string (mirrors what Gmail returns). */
function b64url(s: string): string {
  return Buffer.from(s).toString("base64url");
}

describe("extractTextFromGmailPayload", () => {
  it("returns empty string for null/undefined payload", () => {
    expect(extractTextFromGmailPayload(null)).toBe("");
    expect(extractTextFromGmailPayload(undefined)).toBe("");
  });

  it("returns empty string for payload with no body data", () => {
    expect(extractTextFromGmailPayload({})).toBe("");
    expect(extractTextFromGmailPayload({ mimeType: "text/plain", body: {} })).toBe("");
  });

  it("decodes a top-level text/plain part", () => {
    const payload = {
      mimeType: "text/plain",
      body: { data: b64url("Hello, world!") },
    };
    expect(extractTextFromGmailPayload(payload)).toBe("Hello, world!");
  });

  it("strips HTML tags from a text/html part", () => {
    const html = "<html><body><p>Hello <b>world</b></p></body></html>";
    const payload = {
      mimeType: "text/html",
      body: { data: b64url(html) },
    };
    const result = extractTextFromGmailPayload(payload);
    expect(result).toContain("Hello");
    expect(result).toContain("world");
    expect(result).not.toContain("<");
  });

  it("prefers text/plain over text/html in a multipart payload", () => {
    const payload = {
      mimeType: "multipart/alternative",
      parts: [
        { mimeType: "text/html",  body: { data: b64url("<p>HTML version</p>") } },
        { mimeType: "text/plain", body: { data: b64url("Plain version") } },
      ],
    };
    expect(extractTextFromGmailPayload(payload)).toBe("Plain version");
  });

  it("falls back to text/html when no text/plain part exists", () => {
    const payload = {
      mimeType: "multipart/alternative",
      parts: [
        { mimeType: "text/html", body: { data: b64url("<p>Only HTML</p>") } },
      ],
    };
    const result = extractTextFromGmailPayload(payload);
    expect(result).toContain("Only HTML");
    expect(result).not.toContain("<p>");
  });

  it("finds text/plain in deeply nested multipart structure", () => {
    const payload = {
      mimeType: "multipart/mixed",
      parts: [
        {
          mimeType: "multipart/alternative",
          parts: [
            { mimeType: "text/plain", body: { data: b64url("Deep plain text") } },
            { mimeType: "text/html",  body: { data: b64url("<p>Deep HTML</p>") } },
          ],
        },
        { mimeType: "application/pdf", body: { attachmentId: "att1" } },
      ],
    };
    expect(extractTextFromGmailPayload(payload)).toBe("Deep plain text");
  });

  it("handles base64url-encoded strings with padding edge cases", () => {
    const text = "Short";
    const payload = {
      mimeType: "text/plain",
      body: { data: b64url(text) },
    };
    expect(extractTextFromGmailPayload(payload)).toBe(text);
  });
});
