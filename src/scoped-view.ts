import * as vscode from "vscode";
import type { Scope } from "./changes";
import { ImageChangesTree, ImageTreeItem } from "./sidebar";

const groupScope = (item: ImageTreeItem): Scope | undefined =>
  /^universal_diff_viewer\.group\.(\w+)$/.exec(item.contextValue ?? "")?.[1] as
    | Scope
    | undefined;

export class ScopedChangesView
  implements vscode.TreeDataProvider<ImageTreeItem>, vscode.Disposable
{
  private readonly changed = new vscode.EventEmitter<
    ImageTreeItem | ImageTreeItem[] | undefined
  >();
  readonly onDidChangeTreeData = this.changed.event;
  private readonly subscription: vscode.Disposable;

  constructor(
    readonly model: ImageChangesTree,
    private readonly scopes: readonly Scope[],
    private readonly flattened: Scope,
  ) {
    this.subscription = model.onDidChangeTreeData((event) => {
      if (!event) return this.changed.fire(undefined);
      const all = Array.isArray(event) ? event : [event];
      if (all.some((item) => !this.scopeOf(item))) return this.changed.fire(undefined);
      const items = all.filter((item) => this.owns(item));
      if (items.some((item) => !item.change && !this.visible(item)))
        this.changed.fire(undefined);
      else if (items.length) this.changed.fire(items);
    });
  }

  private get multiple() {
    return this.model.getChildren().some((root) => !groupScope(root));
  }

  scopeOf(item: ImageTreeItem): Scope | undefined {
    if (item.change) return item.change.scope;
    for (let node: ImageTreeItem | undefined = item; node; node = node.parent) {
      const scope = groupScope(node);
      if (scope) return scope;
    }
    return undefined;
  }

  owns(item: ImageTreeItem): boolean {
    const scope = this.scopeOf(item);
    return !!scope && this.scopes.includes(scope);
  }

  private visible(item: ImageTreeItem): boolean {
    const scope = groupScope(item);
    if (!scope) return !!item.parent || !!item.change;
    return this.scopes.includes(scope) && (scope !== this.flattened || this.multiple);
  }

  getTreeItem(item: ImageTreeItem): vscode.TreeItem {
    return this.model.getTreeItem(item);
  }

  getChildren(item?: ImageTreeItem): ImageTreeItem[] {
    if (item) return this.model.getChildren(item);
    const multiple = this.multiple;
    return this.model.getChildren().flatMap((root) => {
      const groups = groupScope(root) ? [root] : (root.children ?? []);
      return groups.flatMap((group) => {
        const scope = groupScope(group)!;
        if (!this.scopes.includes(scope)) return [];
        if (multiple) return [group];
        return scope === this.flattened ? (group.children ?? []) : [group];
      });
    });
  }

  getParent(item: ImageTreeItem): ImageTreeItem | undefined {
    const parent = item.parent;
    if (!parent || !groupScope(parent)) return groupScope(item) ? undefined : parent;
    return this.visible(parent) ? parent : undefined;
  }

  leaves(): ImageTreeItem[] {
    return this.model.leaves().filter((item) => this.owns(item));
  }

  dispose() {
    this.subscription.dispose();
    this.changed.dispose();
  }
}
