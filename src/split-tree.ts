import type { RemoteFile, SplitItem } from "../shared/types";

export interface SplitNode {
  id: string;
  file: RemoteFile;
  path: string;
  depth: number;
  parentId: string | null;
  item?: SplitItem;
  children: SplitNode[];
}

const names = new Intl.Collator("zh-CN", { numeric: true });

/** Reconstruct by stable file IDs; names and path separators are display only. */
export function buildSplitTree(items: SplitItem[]): SplitNode[] {
  const nodes = new Map<string, SplitNode>();
  for (const item of items) {
    const chain = [...item.ancestors, item.file];
    for (let index = 0; index < chain.length; index++) {
      const file = chain[index];
      let node = nodes.get(file.id);
      if (!node) {
        node = {
          id: file.id,
          file,
          depth: index + 1,
          path: chain
            .slice(0, index + 1)
            .map((f) => f.name)
            .join(" / "),
          parentId: chain[index - 1]?.id ?? null,
          children: [],
        };
        nodes.set(file.id, node);
      }
      if (index === chain.length - 1) node.item = item;
    }
  }
  const roots: SplitNode[] = [];
  for (const node of nodes.values()) {
    const parent = node.parentId ? nodes.get(node.parentId) : undefined;
    (parent?.children ?? roots).push(node);
  }
  function sort(rows: SplitNode[]) {
    rows.sort(
      (a, b) =>
        Number(b.file.isDirectory) - Number(a.file.isDirectory) ||
        names.compare(a.file.name, b.file.name),
    );
    rows.forEach((node) => sort(node.children));
  }
  sort(roots);
  return roots;
}

/** Frontier selection keeps shallower files and empty folders. */
export function selectSplitLevel(roots: SplitNode[], depth: number): string[] {
  const ids: string[] = [];
  function walk(node: SplitNode) {
    if (node.depth >= depth || !node.children.length) {
      if (node.item) ids.push(node.item.id);
    } else node.children.forEach(walk);
  }
  roots.forEach(walk);
  return ids;
}

export function visibleSplitNodes(
  roots: SplitNode[],
  collapsed: Set<string>,
  query: string,
): SplitNode[] {
  const result: SplitNode[] = [],
    word = query.trim().toLocaleLowerCase();
  function walk(node: SplitNode): boolean {
    const start = result.length;
    result.push(node);
    if (word || !collapsed.has(node.id)) node.children.forEach(walk);
    if (
      word &&
      !node.path.toLocaleLowerCase().includes(word) &&
      result.length === start + 1
    ) {
      result.pop();
      return false;
    }
    return true;
  }
  roots.forEach(walk);
  return result;
}
