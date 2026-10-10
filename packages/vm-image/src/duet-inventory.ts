import type { ToolInventoryEntry } from "./index.js";

export type DuetToolProbe = { kind: "binary" | "python"; probe: string; importName?: string };

/**
 * Compatibility target copied from Duet's audited required-tools manifest.
 * The names and probes are intentionally kept in source control so image builds
 * can fail when a workflow dependency disappears from the ARM64 image.
 */
export const DUET_REQUIRED_TOOL_NAMES = [
  "bunx", "convert", "curl", "duet-browser", "ffmpeg", "gh", "git", "gs", "jq", "node",
  "pandoc", "pdftotext", "python", "python3", "qpdf", "soffice", "static-web-server", "tesseract", "vips",
  "cairosvg", "docx", "markitdown", "moviepy", "openpyxl", "pandas", "pdf2image", "pdfplumber", "PIL",
  "pillow_heif", "playwright", "pptx", "pypandoc", "pypdf", "pytesseract", "reportlab", "requests", "yaml",
] as const;

const PYTHON_IMPORTS: Record<string, string> = {
  cairosvg: "cairosvg", docx: "docx", markitdown: "markitdown", moviepy: "moviepy", openpyxl: "openpyxl",
  pandas: "pandas", pdf2image: "pdf2image", pdfplumber: "pdfplumber", PIL: "PIL", pillow_heif: "pillow_heif",
  playwright: "playwright", pptx: "pptx", pypandoc: "pypandoc", pypdf: "pypdf", pytesseract: "pytesseract",
  reportlab: "reportlab", requests: "requests", yaml: "yaml",
};

const BINARY_PROBES: Record<string, string> = {
  bunx: "bunx --version", convert: "convert --version", curl: "curl --version", "duet-browser": "duet-browser --version",
  ffmpeg: "ffmpeg -version", gh: "gh --version", git: "git --version", gs: "gs --version", jq: "jq --version",
  node: "node --version", pandoc: "pandoc --version", pdftotext: "pdftotext -v", python: "python --version",
  python3: "python3 --version", qpdf: "qpdf --version", soffice: "soffice --headless --version",
  "static-web-server": "static-web-server --version", tesseract: "tesseract --version", vips: "vips --version",
};

export const DUET_TOOL_PROBES: Record<string, DuetToolProbe> = Object.fromEntries(
  DUET_REQUIRED_TOOL_NAMES.map((name) => PYTHON_IMPORTS[name]
    ? [name, { kind: "python", importName: PYTHON_IMPORTS[name], probe: `python3 -c 'import ${PYTHON_IMPORTS[name]}'` }]
    : [name, { kind: "binary", probe: BINARY_PROBES[name] ?? `${name} --version` }]),
);

export const DUET_REQUIRED_TOOL_INVENTORY: ToolInventoryEntry[] = DUET_REQUIRED_TOOL_NAMES.map((name) => ({
  name,
  kind: DUET_TOOL_PROBES[name].kind,
  architecture: DUET_TOOL_PROBES[name].kind === "python" ? "noarch" : "arm64",
  source: "native",
}));
