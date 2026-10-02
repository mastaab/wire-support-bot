import type { PartAssetWording } from "../../domain/entities/SupportRequest";

/**
 * The asset essential of a part order as the model prompts describe it: always the item the part
 * is for, with the deployment's own question and label, so the model knows what counts (a serial
 * number, an inventory number, a room) without wording hard-wired for one kind of service desk.
 */
export function partAssetDescription(asset: PartAssetWording): string {
  const question = oneLine(asset.question).replace(/\.+$/, "");
  return `the item the part is for; this service desk asks for ${question} and labels it "${oneLine(asset.label)}". Take the item as the requester names it (for example "truck 12" or "the printer on floor 2"): it counts as given even without a serial, fleet or other number`;
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}
