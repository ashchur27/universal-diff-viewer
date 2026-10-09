export interface NavigationNode {
  id?: string;
  change?: unknown;
  children?: readonly NavigationNode[];
}

export type NavigationDirection = "up" | "down";

export function adjacentFile<T extends NavigationNode>(
  roots: readonly T[],
  current: T | undefined,
  direction: NavigationDirection,
): T | undefined {
  const flat: T[] = [];
  const walk = (nodes: readonly NavigationNode[]) => {
    for (const node of nodes) {
      flat.push(node as T);
      if (node.children) walk(node.children);
    }
  };
  walk(roots);
  const index = current
    ? flat.findIndex(
        (node) =>
          node === current || (node.id !== undefined && node.id === current.id),
      )
    : -1;
  const step = direction === "down" ? 1 : -1;
  const start =
    index >= 0 ? index + step : direction === "down" ? 0 : flat.length - 1;
  for (let i = start; i >= 0 && i < flat.length; i += step)
    if (flat[i].change) return flat[i];
  return undefined;
}
