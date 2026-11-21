import { ContractError, OUTPUT_CAP_BYTES, type Json } from "../../contract/src/index.js";
import type { DesktopSurface } from "./surface.js";

/** Screenshots must fit the output cap whole: trimming base64 corrupts the image, so oversize shots are re-encoded. */
const SCREENSHOT_BUDGET = OUTPUT_CAP_BYTES - 16 * 1024;
export const REENCODE_STEPS = [{ quality: 80, scale: 1 }, { quality: 60, scale: 1 }, { quality: 60, scale: 0.75 }, { quality: 50, scale: 0.5 }] as const;
export const dataUrl = (mime: string, base64: string) => `data:${mime};base64,${base64}`;
export const fits = (mime: string, base64: string) => Buffer.byteLength(dataUrl(mime, base64)) <= SCREENSHOT_BUDGET;

/** The whole display, PNG when it fits and JPEG steps when not, with the display's real size. */
export async function desktopScreenshot(surface: DesktopSurface): Promise<Json> {
  const { width, height } = await surface.geometry();
  const png = (await surface.capture({ format: "png" })).toString("base64");
  if (fits("image/png", png)) return { mime_type: "image/png", data: dataUrl("image/png", png), width, height };
  for (const step of REENCODE_STEPS) {
    const jpeg = (await surface.capture({ format: "jpeg", ...step })).toString("base64");
    if (fits("image/jpeg", jpeg)) return { mime_type: "image/jpeg", data: dataUrl("image/jpeg", jpeg), width, height, reencoded: { from: "image/png", original_bytes: Buffer.byteLength(dataUrl("image/png", png)), quality: step.quality, scale: step.scale } };
  }
  throw new ContractError("resource_exhausted", "desktop screenshot does not fit the output cap even re-encoded");
}
