// Adapted from hud (Apache-2.0), built on Token Weather Usage; see NOTICE and LICENSE-APACHE.

// True for a tree with nothing to show: nothing, empty text, or nested empty boxes and texts.
export function isBlank(node: any): boolean {
  if (node == null || node === false || node === "") return true;
  if (Array.isArray(node)) return node.every(isBlank);
  if (typeof node === "string") return node.trim() === "";
  // An element carries its children beside its props, not inside them.
  if (typeof node === "object" && (node.type === "Box" || node.type === "Text")) return isBlank(node.children ?? node.props?.children);
  return false;
}
