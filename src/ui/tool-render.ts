import { Text } from "@earendil-works/pi-tui";

/**
 * The pi-tui side of tool rendering. The extension loads this module only in
 * a TUI session, so print, rpc, and json sessions never import pi-tui; the
 * one-line summaries themselves come from the declaration table.
 */
export function textComponent(text: string): Text {
	return new Text(text, 0, 0);
}
