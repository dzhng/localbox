import type { ToolInventoryEntry } from "./index.js";

/**
 * Compatibility target copied from Duet's audited required-tools manifest.
 * Versions and checksums are filled by the image build, never guessed here.
 */
export const DUET_REQUIRED_TOOL_NAMES = [
  "bunx", "convert", "curl", "duet-browser", "ffmpeg", "gh", "git", "gs", "jq", "node",
  "pandoc", "pdftotext", "python", "python3", "qpdf", "soffice", "static-web-server", "tesseract", "vips",
  "cairosvg", "docx", "markitdown", "moviepy", "openpyxl", "pandas", "pdf2image", "pdfplumber", "PIL",
  "pillow_heif", "playwright", "pptx", "pypandoc", "pypdf", "pytesseract", "reportlab", "requests", "yaml",
] as const;

export const DUET_REQUIRED_TOOL_INVENTORY: ToolInventoryEntry[] = DUET_REQUIRED_TOOL_NAMES.map((name) => ({
  name,
  kind: ["cairosvg", "docx", "markitdown", "moviepy", "openpyxl", "pandas", "pdf2image", "pdfplumber", "PIL", "pillow_heif", "playwright", "pptx", "pypandoc", "pypdf", "pytesseract", "reportlab", "requests", "yaml"].includes(name as never) ? "python" : "binary",
  architecture: ["cairosvg", "docx", "markitdown", "moviepy", "openpyxl", "pandas", "pdf2image", "pdfplumber", "PIL", "pillow_heif", "playwright", "pptx", "pypandoc", "pypdf", "pytesseract", "reportlab", "requests", "yaml"].includes(name as never) ? "noarch" : "arm64",
  source: "native",
}));
