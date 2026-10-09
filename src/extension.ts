import * as vscode from "vscode";
import { randomBytes } from "node:crypto";
import { fileKind, ImageChange, ImageSource, mimeType, publicChange, Scope } from "./changes";
import { GitAPI, GitExtension } from "./git-api";
import {
  ImageChangesTree,
  ImageTreeItem,
  imageQuickPicks,
  sidebarViewId,
  stagedViewId,
} from "./sidebar";
import { ImageIgnore } from "./image-ignore";
import { ImageAction, ImageActions, leaves } from "./actions";
import { ImageStatistics } from "./statistics";
import { ImageActionTask } from "./action-queue";
import {
  FailureArtifacts,
  FailureFile,
  ImageFilter,
  imageFilters,
} from "./failures";
import { diffWorkbooks, readWorkbook } from "./xlsx";
import { diffCsv } from "./csv";
import { renderTabularDiffHtml } from "./tabular";
import { readPdf, renderPdfDiffHtml } from "./pdf";
import { adjacentFile } from "./tree-navigation";
import { readGitBlob } from "./git-blob";
import { ScopedChangesView } from "./scoped-view";

const viewType = "universal_diff_viewer.review";

class Review implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private changes = new Map<string, ImageChange>();
  private timer?: ReturnType<typeof setTimeout>;
  private sequence = 0;
  private lastSnapshot = "";
  private ready = false;
  private disposed = false;
  readonly viewed = new Map<string, string>();
  private sent = new Map<string, string>();
  private statisticsRunning = false;
  private statisticsAgain = false;
  private statisticsReply?: (data: Record<string, unknown>) => void;
  private statisticsSequence = 0;
  private preferred?: { path: string; scope?: Scope };

  constructor(
    readonly panel: vscode.WebviewPanel,
    private readonly context: vscode.ExtensionContext,
    private readonly api: GitAPI,
    private readonly ignores: ImageIgnore,
    private readonly sidebar: ImageChangesTree,
    private readonly statistics: ImageStatistics,
    private readonly runAction: (
      action: ImageAction,
      nodes: ImageTreeItem[],
    ) => Promise<void>,
    private readonly reveal: (change: ImageChange) => Promise<void>,
  ) {
    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, "media")],
    };
    this.disposables.push(
      ignores.onDidChange(() => this.snapshot()),
      sidebar.onDidChangeRevisions(() => this.schedule()),
      sidebar.onDidChangeTreeData(() => this.schedule()),
      panel.onDidDispose(() => this.dispose()),
      panel.webview.onDidReceiveMessage((message) => {
        void this.receive(message).catch((error) => this.report(error));
      }),
      panel.onDidChangeViewState(() => {
        if (panel.visible) this.schedule();
      }),
    );
    void this.html().catch((error) => this.report(error));
  }

  select(path: string, scope?: Scope, preserveFocus = false) {
    this.preferred = { path, scope };
    this.panel.reveal(undefined, preserveFocus);
    this.snapshot();
  }

  private schedule() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.snapshot(), 250);
  }

  private snapshot() {
    if (!this.ready || this.disposed) return;
    const changes = this.sidebar
      .leaves()
      .map((node) => node.change!)
      .filter((change) => change.kind === "image");
    this.changes = new Map(changes.map((change) => [change.id, change]));
    const preferred = this.preferred;
    const matching =
      preferred &&
      changes.filter((change) =>
        [change.before?.uri.fsPath, change.after?.uri.fsPath].includes(
          preferred.path,
        ),
      );
    const selected =
      matching &&
      (matching.find((change) => change.scope === preferred?.scope) ??
        matching[0]);
    this.preferred = undefined;
    void this.updateStatistics();
    const snapshot = {
      type: "snapshot",
      changes: changes.map(publicChange),
      showIgnored: this.ignores.showIgnored,
      filter: this.sidebar.filter,
      failureCount: this.sidebar.failureCount,
      selected: selected?.id,
      repositories: this.api.repositories.map((repo) => ({
        root: repo.rootUri.fsPath,
        name: repo.rootUri.path.split("/").pop(),
      })),
      notice:
        preferred && !selected
          ? "No visible file changes found for the selected file. Check .image_ignore for excluded images."
          : "",
    };
    const fingerprint = JSON.stringify(snapshot);
    if (fingerprint !== this.lastSnapshot || preferred) {
      this.lastSnapshot = fingerprint;
      void this.panel.webview.postMessage(snapshot);
    }
  }

  private async updateStatistics() {
    if (this.statisticsRunning) {
      this.statisticsAgain = true;
      return;
    }
    if (
      this.statisticsRunning ||
      !this.ready ||
      this.disposed ||
      this.sidebar.backgroundChecksPaused ||
      !this.panel.visible
    )
      return;
    this.statisticsRunning = true;
    try {
      for (const node of this.sidebar.leaves()) {
        if (node.change?.scope === "failure" || node.change?.kind !== "image")
          continue;
        if (
          this.disposed ||
          !this.panel.visible ||
          this.sidebar.backgroundChecksPaused
        )
          break;
        await this.sidebar.prepare(node);
        if (this.sidebar.backgroundChecksPaused) break;
        const change = node.change!;
        if (
          !change.revision ||
          node.metrics.ready ||
          this.statistics.get(change.revision)
        )
          continue;
        const comparison = await this.sidebar.images.comparison(change);
        if (comparison.revision !== change.revision) continue;
        const request = ++this.statisticsSequence;
        const result = await new Promise<Record<string, unknown>>((resolve) => {
          const timer = setTimeout(() => {
            this.statisticsReply = undefined;
            resolve({ error: "Timed out" });
          }, 30000);
          this.statisticsReply = (data) => {
            clearTimeout(timer);
            this.statisticsReply = undefined;
            resolve(data);
          };
          void this.panel.webview.postMessage({
            type: "statistics",
            id: change.id,
            request,
            ...comparison,
          });
        });
        if (this.disposed) break;
        this.statistics.set(change.revision, {
          changed: typeof result.changed === "number" ? result.changed : 0,
          total: typeof result.total === "number" ? result.total : 0,
          ...(result.error ? { error: String(result.error) } : {}),
        });
      }
    } catch (error) {
      this.report(error);
    } finally {
      this.statisticsRunning = false;
      if (this.statisticsAgain) {
        this.statisticsAgain = false;
        void this.updateStatistics();
      }
    }
  }

  private async receive(message: unknown) {
    if (!message || typeof message !== "object" || !("type" in message)) return;
    const data = message as Record<string, unknown>;
    switch (data.type) {
      case "ready":
        this.lastSnapshot = "";
        this.ready = true;
        this.snapshot();
        break;
      case "statisticsResult":
        if (data.request === this.statisticsSequence)
          this.statisticsReply?.(data);
        break;
      case "viewed":
        if (
          typeof data.id === "string" &&
          typeof data.revision === "string" &&
          this.sent.get(data.id) === data.revision
        )
          this.viewed.set(data.id, data.revision);
        break;
      case "reveal": {
        const change =
          typeof data.id === "string" ? this.changes.get(data.id) : undefined;
        if (change) await this.reveal(change);
        break;
      }
      case "action": {
        if (
          typeof data.id !== "string" ||
          !Number.isSafeInteger(data.request) ||
          ![
            "stage",
            "unstage",
            "discard",
            "ignore",
            "unignore",
            "deleteFailure",
          ].includes(String(data.action))
        )
          return;
        try {
          const change = this.changes.get(data.id);
          if (!change) return;
          if (
            change.scope === "failure" &&
            !["ignore", "unignore", "deleteFailure"].includes(
              String(data.action),
            )
          )
            return;
          if (data.action === "deleteFailure" && change.scope !== "failure")
            return;
          if (
            typeof data.revision !== "string" ||
            this.viewed.get(change.id) !== data.revision
          ) {
            this.report(
              new Error("Wait for the current image to load, then try again."),
            );
            return;
          }
          const item = new ImageTreeItem(change.path);
          item.change = { ...change, revision: data.revision };
          if (data.action === "deleteFailure")
            await vscode.commands.executeCommand(
              "universal_diff_viewer.deleteSelectedFailures",
              item,
              [item],
            );
          else await this.runAction(data.action as ImageAction, [item]);
        } finally {
          this.snapshot();
          void this.panel.webview.postMessage({
            type: "actionComplete",
            request: data.request,
          });
        }
        break;
      }
      case "showSidebar":
        await vscode.commands.executeCommand(`${sidebarViewId}.focus`);
        break;
      case "cleanFailures":
        await vscode.commands.executeCommand("universal_diff_viewer.deleteFailures");
        break;
      case "refresh": {
        this.statistics.retryUnavailable();
        await this.sidebar.refresh();
        this.snapshot();
        break;
      }
      case "load": {
        if (typeof data.id !== "string" || !Number.isSafeInteger(data.request))
          return;
        const sequence = ++this.sequence;
        const change = this.changes.get(data.id);
        if (!change) return;
        if (change.scope === "failure") {
          const node =
            change.after && this.sidebar.findFile(change.after.uri, "failure");
          if (node) await this.sidebar.prepare(node, true);
        }
        const comparison = await this.sidebar.images.comparison(
          change,
          typeof data.revision === "string" ? data.revision : undefined,
        );
        if (sequence === this.sequence && !this.disposed) {
          this.sent.set(change.id, comparison.revision);
          await this.panel.webview.postMessage({
            type: "images",
            id: change.id,
            request: data.request,
            ...comparison,
          });
        }
        break;
      }
      case "open": {
        if (typeof data.id !== "string") return;
        const source = this.changes.get(data.id)?.after;
        if (source)
          await vscode.commands.executeCommand(
            "vscode.open",
            source.ref === undefined
              ? source.uri
              : this.api.toGitUri(source.uri, source.ref),
          );
        break;
      }
    }
  }

  private report(error: unknown) {
    if (!this.disposed)
      void this.panel.webview.postMessage({
        type: "error",
        message: error instanceof Error ? error.message : String(error),
      });
  }

  private async html() {
    const webview = this.panel.webview;
    const media = vscode.Uri.joinPath(this.context.extensionUri, "media");
    let html = Buffer.from(
      await vscode.workspace.fs.readFile(
        vscode.Uri.joinPath(media, "viewer.html"),
      ),
    ).toString("utf8");
    const escape = (value: string) =>
      value
        .replace(/&/g, "&amp;")
        .replace(/"/g, "&quot;")
        .replace(/</g, "&lt;");
    const nonce = randomBytes(18).toString("base64");
    html = html
      .replaceAll("__CSP__", escape(webview.cspSource))
      .replaceAll("__NONCE__", nonce)
      .replaceAll(
        "__STYLE__",
        escape(
          webview
            .asWebviewUri(vscode.Uri.joinPath(media, "viewer.css"))
            .toString(),
        ),
      )
      .replaceAll(
        "__SCRIPT__",
        escape(
          webview
            .asWebviewUri(vscode.Uri.joinPath(media, "viewer.mjs"))
            .toString(),
        ),
      );
    if (!this.disposed) webview.html = html;
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.sequence++;
    this.statisticsReply?.({ error: "Closed" });
    clearTimeout(this.timer);
    this.disposables.forEach((value) => value.dispose());
    this.panel.dispose();
  }
}

export async function activate(context: vscode.ExtensionContext) {
  const extension = vscode.extensions.getExtension<GitExtension>("vscode.git");
  const git = await extension?.activate();
  if (!git?.enabled) {
    const unavailable = () =>
      vscode.window.showErrorMessage(
        "Enable the built-in Git extension to use Universal Diff Viewer.",
      );
    context.subscriptions.push(
      vscode.commands.registerCommand("universal_diff_viewer.open", unavailable),
      vscode.commands.registerCommand("universal_diff_viewer.openFile", unavailable),
      vscode.commands.registerCommand("universal_diff_viewer.refresh", unavailable),
      vscode.commands.registerCommand("universal_diff_viewer.findImage", unavailable),
      ...[
        "stage",
        "unstage",
        "discard",
        "ignore",
        "unignore",
        "showIgnored",
      ].map((action) =>
        vscode.commands.registerCommand(`universal_diff_viewer.${action}`, unavailable),
      ),
      vscode.window.registerTreeDataProvider(sidebarViewId, {
        getTreeItem: (item: vscode.TreeItem) => item,
        getChildren: () => [
          new vscode.TreeItem(
            "Enable the built-in Git extension to load file changes.",
          ),
        ],
      }),
      vscode.window.registerTreeDataProvider(stagedViewId, {
        getTreeItem: (item: vscode.TreeItem) => item,
        getChildren: () => [],
      }),
    );
    return;
  }
  const api = git.getAPI(1);
  const ignores = new ImageIgnore(api);
  context.subscriptions.push(ignores);
  await ignores.refresh();
  const statistics = new ImageStatistics();
  context.subscriptions.push(statistics);
  ignores.showIgnored = context.workspaceState.get("showIgnored", false);
  const failures = new FailureArtifacts(api);
  context.subscriptions.push(failures);
  const sidebar = new ImageChangesTree(api, ignores, statistics, failures);
  const savedFilter = context.workspaceState.get<string>("imageFilter", "all");
  sidebar.setFilter(
    savedFilter in imageFilters ? (savedFilter as ImageFilter) : "all",
  );
  let review: Review | undefined;
  const actions = new ImageActions(api, ignores, sidebar, undefined, (id) =>
    review?.viewed.get(id),
  );
  const unstagedProvider = new ScopedChangesView(
    sidebar,
    ["conflict", "working", "failure"],
    "working",
  );
  const stagedProvider = new ScopedChangesView(sidebar, ["staged"], "staged");
  const tree = vscode.window.createTreeView(sidebarViewId, {
    treeDataProvider: unstagedProvider,
    showCollapseAll: true,
    canSelectMany: true,
  });
  const stagedTree = vscode.window.createTreeView(stagedViewId, {
    treeDataProvider: stagedProvider,
    showCollapseAll: true,
    canSelectMany: true,
  });
  const views = { unstaged: tree, staged: stagedTree };
  let activeTree = tree;
  const viewFor = (scope?: Scope) => (scope === "staged" ? stagedTree : tree);
  const providerFor = (view: vscode.TreeView<ImageTreeItem>) =>
    view === stagedTree ? stagedProvider : unstagedProvider;
  let lastCount = -1;
  let lastIgnored: boolean | undefined;
  let lastMessage: string | undefined;
  let lastFailures: boolean | undefined;
  let lastFilter: ImageFilter | undefined;
  const updateBadge = () => {
    const count = sidebar.count;
    const message = [
      `${imageFilters[sidebar.filter]} · ${failures.count} failure ${failures.count === 1 ? "image" : "images"}`,
      ignores.showIgnored ? "Ignored images are visible" : "",
      ...failures.warnings,
    ]
      .filter(Boolean)
      .join("\n");
    if (message !== lastMessage) tree.message = lastMessage = message;
    if (lastFailures !== !!failures.count) {
      lastFailures = !!failures.count;
      void vscode.commands.executeCommand(
        "setContext",
        "universal_diff_viewer.hasFailures",
        lastFailures,
      );
    }
    if (lastFilter !== sidebar.filter) {
      lastFilter = sidebar.filter;
      void vscode.commands.executeCommand(
        "setContext",
        "universal_diff_viewer.imageFilter",
        lastFilter,
      );
    }
    if (lastIgnored !== ignores.showIgnored) {
      lastIgnored = ignores.showIgnored;
      void vscode.commands.executeCommand(
        "setContext",
        "universal_diff_viewer.showIgnored",
        ignores.showIgnored,
      );
    }
    if (lastCount !== count) {
      lastCount = count;
      tree.badge = count
        ? { value: count, tooltip: `${count} file changes` }
        : undefined;
    }
  };
  updateBadge();
  context.subscriptions.push(
    sidebar,
    unstagedProvider,
    stagedProvider,
    tree,
    stagedTree,
    vscode.window.registerFileDecorationProvider(sidebar),
    ignores.onDidChange(updateBadge),
    sidebar.onDidChangeTreeData(updateBadge),
    failures.onDidChange(updateBadge),
  );
  void failures.refresh();
  let queueProgress: Promise<void> | undefined;
  const showQueueProgress = () => {
    if (queueProgress || actions.queue.idle) return;
    queueProgress = Promise.resolve(
      vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: "Universal Diff Viewer",
          cancellable: false,
        },
        async (progress) => {
          const update = () =>
            progress.report({ message: actions.queue.message });
          const subscription = actions.queue.onDidChange(update);
          update();
          try {
            await actions.queue.whenIdle();
          } finally {
            subscription.dispose();
          }
        },
      ),
    ).finally(() => {
      queueProgress = undefined;
      // A new task can arrive as the previous progress notification closes.
      showQueueProgress();
    });
  };
  context.subscriptions.push(actions.queue.onDidChange(showQueueProgress));
  const commands = new Map<ImageActionTask, Promise<void>>();
  const finishTask = async (task: ImageActionTask, label: string) => {
    const existing = commands.get(task);
    if (existing) return existing;
    const completion = task.result
      .then((count) => {
        if (count)
          void vscode.window.setStatusBarMessage(
            `Universal Diff Viewer: ${label} — ${count} images`,
            5000,
          );
      })
      .catch((error) => {
        void vscode.window.showErrorMessage(
          `Universal Diff Viewer: ${error instanceof Error ? error.message : String(error)}`,
        );
      })
      .finally(() => commands.delete(task));
    commands.set(task, completion);
    return completion;
  };
  const cleanupFailures = async (files: readonly FailureFile[]) => {
    if (!files.length) {
      void vscode.window.showInformationMessage(
        failures.scanning
          ? "Scanning failure images. Try again when the scan completes."
          : "No failure images to delete.",
      );
      return;
    }
    const key = JSON.stringify([
      "deleteFailures",
      files.map((file) => [
        file.uri.toString(),
        file.size,
        file.mtime,
        file.ctime,
        file.revision,
      ]),
    ]);
    const task = actions.queue.enqueue(
      key,
      `Delete ${files.length} failure images`,
      async (report) => {
        const paused = sidebar.pauseBackgroundChecks();
        try {
          return await failures.clean(files, report);
        } finally {
          try {
            await sidebar.refresh(
              [],
              api.repositories.filter((repo) =>
                files.some(
                  (file) => file.root.toString() === repo.rootUri.toString(),
                ),
              ),
            );
          } finally {
            paused.dispose();
          }
        }
      },
    );
    await finishTask(task, "Moved failures to Trash");
  };
  const selectedTreeNodes = (input: unknown, selection?: ImageTreeItem[]) => {
    if (!(input instanceof ImageTreeItem)) return selection ?? [...activeTree.selection];
    const selected = selection ?? [...viewFor(input.change?.scope ?? unstagedProvider.scopeOf(input)).selection];
    return selected.some((node) => node.id === input.id) ? selected : [input];
  };
  const runAction = async (action: ImageAction, nodes: ImageTreeItem[]) => {
    try {
      const task = actions.enqueue(action, nodes);
      await finishTask(task, action);
    } catch (error) {
      void vscode.window.showErrorMessage(
        `Universal Diff Viewer: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };
  const runBulkAction = async (action: ImageAction, nodes: ImageTreeItem[]) => {
    if (!nodes.length) {
      void vscode.window.showInformationMessage(
        "Universal Diff Viewer: No visible file changes to process.",
      );
      return;
    }
    const roots = new Map<string, { label: string; nodes: ImageTreeItem[] }>();
    for (const node of nodes) {
      const root = node.change!.root;
      const group = roots.get(root) ?? {
        label: node.change!.repository,
        nodes: [],
      };
      group.nodes.push(node);
      roots.set(root, group);
    }
    const choices = [
      {
        label: "All repositories",
        description: `${nodes.length} visible changes`,
        nodes,
      },
      ...[...roots.entries()].map(([root, group]) => ({
        label: group.label,
        description: `${group.nodes.length} visible changes · ${root}`,
        nodes: group.nodes,
      })),
    ];
    const selected =
      roots.size === 1
        ? choices[1]
        : await vscode.window.showQuickPick(choices, {
            title: `Universal Diff Viewer: ${action} visible changes`,
            placeHolder: "Choose the repository scope",
          });
    if (selected) await runAction(action, selected.nodes);
  };
  const reveal = async (change: ImageChange) => {
    const uri = change.after?.uri ?? change.before?.uri;
    const item = uri && sidebar.findFile(uri, change.scope);
    if (item) await viewFor(change.scope).reveal(item, { select: true, focus: false });
  };
  const attach = (panel: vscode.WebviewPanel) => {
    review = new Review(
      panel,
      context,
      api,
      ignores,
      sidebar,
      statistics,
      runAction,
      reveal,
    );
    const current = review;
    context.subscriptions.push(
      current,
      panel.onDidDispose(() => {
        if (review === current) review = undefined;
      }),
    );
    return current;
  };
  const resolveSource = (source?: ImageSource) =>
    !source
      ? undefined
      : source.ref === undefined
        ? source.uri
        : api.toGitUri(source.uri, source.ref);
  const focusTreeItem = (uri: vscode.Uri, scope?: Scope) => {
    const item = sidebar.findFile(uri, scope);
    if (item)
      void viewFor(item.change?.scope).reveal(item, { select: false, focus: true, expand: false });
  };
  const tabularPanels = new Map<string, vscode.WebviewPanel>();
  const maxTabularBytes = 20 * 1024 * 1024;
  const readTabularBytes = async (root: string, source?: ImageSource) => {
    if (!source) return undefined;
    if (source.ref !== undefined)
      return readGitBlob(
        api.git?.path ?? "git",
        root,
        source.uri.fsPath,
        source.ref,
        maxTabularBytes,
      );
    const stat = await vscode.workspace.fs.stat(source.uri);
    if (stat.size > maxTabularBytes)
      throw new Error("File exceeds the 20 MiB preview limit");
    return vscode.workspace.fs.readFile(source.uri);
  };
  const showTabularDiff = (change: ImageChange, html: string) => {
    const key = change.id;
    const title = `Diff: ${change.path}${change.scope === "staged" ? " (Staged)" : ""}`;
    const existing = tabularPanels.get(key);
    if (existing) {
      existing.webview.html = html;
      existing.reveal(vscode.ViewColumn.Active);
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      "universal_diff_viewer.tabularDiff",
      title,
      vscode.ViewColumn.Active,
      { enableScripts: false },
    );
    panel.webview.html = html;
    tabularPanels.set(key, panel);
    panel.onDidDispose(() => {
      if (tabularPanels.get(key) === panel) tabularPanels.delete(key);
    });
  };
  const readDocumentPair = (change: ImageChange) =>
    Promise.all([
      readTabularBytes(change.root, change.before),
      readTabularBytes(change.root, change.after),
    ]);
  let extendedSequence = 0;
  const openWorkbookDiff = async (label: string, change: ImageChange, sequence: number) => {
    const [beforeBytes, afterBytes] = await readDocumentPair(change);
    if (sequence !== extendedSequence) return;
    const beforeBook = beforeBytes && readWorkbook(beforeBytes);
    const afterBook = afterBytes && readWorkbook(afterBytes);
    showTabularDiff(change, renderTabularDiffHtml(label, diffWorkbooks(beforeBook, afterBook), change.status));
  };
  const openCsvDiff = async (label: string, change: ImageChange, sequence: number) => {
    const [beforeBytes, afterBytes] = await readDocumentPair(change);
    if (sequence !== extendedSequence) return;
    const decode = (bytes?: Uint8Array) =>
      bytes && Buffer.from(bytes).toString("utf8");
    showTabularDiff(
      change,
      renderTabularDiffHtml(label, [
        diffCsv(label, decode(beforeBytes), decode(afterBytes)),
      ], change.status),
    );
  };
  const openPdfDiff = async (label: string, change: ImageChange, sequence: number) => {
    const [beforeBytes, afterBytes] = await readDocumentPair(change);
    if (sequence !== extendedSequence) return;
    const beforePdf = beforeBytes && readPdf(beforeBytes);
    const afterPdf = afterBytes && readPdf(afterBytes);
    showTabularDiff(
      change,
      renderPdfDiffHtml(label, beforePdf, afterPdf, change.status),
    );
  };
  const openExtendedDiff = async (
    uri: vscode.Uri,
    scope: Scope | undefined,
    kind: "text" | "document",
    fromTree: boolean,
  ) => {
    const sequence = ++extendedSequence;
    const focusTreeFile = (target: vscode.Uri, targetScope?: Scope) => {
      if (fromTree && sequence === extendedSequence) focusTreeItem(target, targetScope);
    };
    const change = sidebar.findFile(uri, scope)?.change;
    const left = resolveSource(change?.before);
    const right = resolveSource(change?.after);
    const label = change?.path ?? uri.fsPath;
    if (kind === "text" && /\.csv$/i.test(uri.fsPath) && change && (left || right)) {
      try {
        await openCsvDiff(label, change, sequence);
        focusTreeFile(uri, scope);
        return;
      } catch (error) {
        void vscode.window.showWarningMessage(
          `Universal Diff Viewer: Could not render a CSV diff (${error instanceof Error ? error.message : String(error)}). Opening the native diff instead.`,
        );
      }
    }
    if (kind === "text" && left && right) {
      await vscode.commands.executeCommand(
        "vscode.diff",
        left,
        right,
        `${label} · ${change?.status ?? "Modified"} (${change?.before?.label ?? "Before"} ↔ ${change?.after?.label ?? "After"})`,
      );
      focusTreeFile(uri, scope);
      return;
    }
    if (kind === "document" && /\.xlsx$/i.test(uri.fsPath) && change && (left || right)) {
      try {
        await openWorkbookDiff(label, change, sequence);
        focusTreeFile(uri, scope);
        return;
      } catch (error) {
        void vscode.window.showWarningMessage(
          `Universal Diff Viewer: Could not render a spreadsheet diff (${error instanceof Error ? error.message : String(error)}). Opening both versions instead.`,
        );
      }
    }
    if (kind === "document" && /\.pdf$/i.test(uri.fsPath) && change && (left || right)) {
      try {
        await openPdfDiff(label, change, sequence);
        focusTreeFile(uri, scope);
        return;
      } catch (error) {
        void vscode.window.showWarningMessage(
          `Universal Diff Viewer: Could not extract a PDF text diff (${error instanceof Error ? error.message : String(error)}). Opening both versions instead.`,
        );
      }
    }
    if (kind === "document" && left && right) {
      await vscode.commands.executeCommand("vscode.open", left, {
        viewColumn: vscode.ViewColumn.One,
        preview: false,
      });
      await vscode.commands.executeCommand("vscode.open", right, {
        viewColumn: vscode.ViewColumn.Beside,
        preview: false,
      });
      focusTreeFile(uri, scope);
      return;
    }
    await vscode.commands.executeCommand("vscode.open", right ?? left ?? uri);
    focusTreeFile(uri, scope);
  };
  let lastOpen = { key: "", at: 0 };
  const open = (
    input?: unknown,
    requestedScope?: Scope,
    preserveFocus = false,
  ) => {
    const uri =
      input instanceof vscode.Uri
        ? input
        : input && typeof input === "object" && "resourceUri" in input
          ? (input as { resourceUri: vscode.Uri }).resourceUri
          : undefined;
    const scope: Scope | undefined =
      requestedScope ??
      (input &&
      typeof input === "object" &&
      "resourceGroup" in input &&
      (input as { resourceGroup?: { id?: string } }).resourceGroup?.id ===
        "index"
        ? "staged"
        : undefined);
    // A tree click fires both the item command and the selection listener.
    const key = `${uri?.toString()}|${scope}`;
    if (uri && key === lastOpen.key && Date.now() - lastOpen.at < 500) return;
    lastOpen = { key, at: Date.now() };
    const extendedKind = uri && !mimeType(uri.fsPath) ? fileKind(uri.fsPath) : undefined;
    if (uri && (extendedKind === "text" || extendedKind === "document")) {
      void openExtendedDiff(uri, scope, extendedKind, preserveFocus);
      return;
    }
    const current =
      review ??
      attach(
        vscode.window.createWebviewPanel(
          viewType,
          "Universal Diff Viewer",
          { viewColumn: vscode.ViewColumn.Active, preserveFocus },
          { enableScripts: true, retainContextWhenHidden: true },
        ),
      );
    if (uri && mimeType(uri.fsPath))
      current.select(uri.fsPath, scope, preserveFocus);
    else current.panel.reveal(undefined, preserveFocus);
  };
  const viewFromArgs = (args: unknown) =>
    args && typeof args === "object" && (args as { view?: string }).view === "staged"
      ? stagedTree
      : args && typeof args === "object" && (args as { view?: string }).view === "unstaged"
        ? tree
        : activeTree;
  const moveAndOpenTreeFile = async (direction: "up" | "down", args?: unknown) => {
    const view = viewFromArgs(args);
    const target = adjacentFile(
      providerFor(view).getChildren(),
      view.selection[0],
      direction,
    );
    if (target) await view.reveal(target, { select: true, focus: true });
  };
  const onSelection = (view: vscode.TreeView<ImageTreeItem>) =>
    view.onDidChangeSelection(({ selection }) => {
      if (selection.length) activeTree = view;
      const item = selection[0];
      const change = item?.change;
      const uri = change?.after?.uri ?? change?.before?.uri;
      if (!change || !uri) return;
      setTimeout(() => open(uri, change.scope, true), 0);
    });
  context.subscriptions.push(
    onSelection(tree),
    onSelection(stagedTree),
    vscode.commands.registerCommand("universal_diff_viewer.focusPrevious", async (args?: unknown) => {
      await moveAndOpenTreeFile("up", args);
    }),
    vscode.commands.registerCommand("universal_diff_viewer.focusNext", async (args?: unknown) => {
      await moveAndOpenTreeFile("down", args);
    }),
    vscode.commands.registerCommand("universal_diff_viewer.stageSelection", async () => {
      const nodes = [...views.unstaged.selection].filter((node) => unstagedProvider.scopeOf(node) === "working");
      if (nodes.length) await runAction("stage", nodes);
    }),
    vscode.commands.registerCommand("universal_diff_viewer.unstageSelection", async () => {
      const nodes = [...views.staged.selection];
      if (nodes.length) await runAction("unstage", nodes);
    }),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("universal_diff_viewer.filterImages", async () => {
      const selected = await vscode.window.showQuickPick(
        (Object.entries(imageFilters) as [ImageFilter, string][]).map(
          ([filter, label]) => ({
            label,
            filter,
            description:
              filter === sidebar.filter ? "Current filter" : undefined,
          }),
        ),
        {
          title: "Filter images",
          placeHolder: "Show or hide generated failure images",
        },
      );
      if (!selected) return;
      sidebar.setFilter(selected.filter);
      updateBadge();
      await context.workspaceState.update("imageFilter", selected.filter);
    }),
    vscode.commands.registerCommand("universal_diff_viewer.deleteFailures", () =>
      cleanupFailures(failures.snapshot),
    ),
    vscode.commands.registerCommand(
      "universal_diff_viewer.deleteSelectedFailures",
      async (input: unknown, selection?: ImageTreeItem[]) => {
        const nodes = selectedTreeNodes(input, selection);
        if (!nodes.length) return;
        try {
          await cleanupFailures(failures.select(nodes.flatMap(leaves)));
        } catch (error) {
          void vscode.window.showErrorMessage(
            `Universal Diff Viewer: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      },
    ),
    ...(
      ["stage", "unstage", "discard", "ignore", "unignore"] as ImageAction[]
    ).map((action) =>
      vscode.commands.registerCommand(
        `universal_diff_viewer.${action}`,
        async (input: unknown, selection?: ImageTreeItem[]) => {
          const nodes = selectedTreeNodes(input, selection);
          if (nodes.length) await runAction(action, nodes);
        },
      ),
    ),
    ...(
      ["stage", "unstage"] as const
    ).map((action) =>
      vscode.commands.registerCommand(
        `universal_diff_viewer.${action}Active`,
        () => {
          review?.panel.webview.postMessage({ type: "triggerAction", action });
        },
      ),
    ),
    vscode.commands.registerCommand("universal_diff_viewer.stageAll", async () => {
      await runBulkAction(
        "stage",
        unstagedProvider.leaves().filter((node) => node.change?.scope === "working"),
      );
    }),
    vscode.commands.registerCommand("universal_diff_viewer.unstageAll", async () => {
      await runBulkAction("unstage", stagedProvider.leaves());
    }),
    vscode.commands.registerCommand("universal_diff_viewer.showIgnored", async () => {
      ignores.toggleShowIgnored();
      await context.workspaceState.update("showIgnored", ignores.showIgnored);
    }),
    vscode.commands.registerCommand("universal_diff_viewer.open", open),
    vscode.commands.registerCommand(
      "universal_diff_viewer.openFile",
      (input?: unknown, scope?: Scope, preserveFocus?: boolean) =>
        open(
          input ?? vscode.window.activeTextEditor?.document.uri,
          scope,
          preserveFocus,
        ),
    ),
    vscode.commands.registerCommand("universal_diff_viewer.findImage", async () => {
      const picks = imageQuickPicks(
        api,
        ignores,
        sidebar.leaves().map((node) => node.change!),
      );
      if (!picks.length) {
        void vscode.window.showInformationMessage(
          "No visible file changes found. Check .image_ignore for excluded images.",
        );
        return;
      }
      const selected = await vscode.window.showQuickPick(picks, {
        title: "Find changed file",
        placeHolder:
          "Search by filename, folder, repository, or staged/unstaged state",
        matchOnDescription: true,
        matchOnDetail: true,
      });
      if (!selected) return;
      const { change } = selected;
      const uri = change.after?.uri ?? change.before?.uri;
      if (!uri) return;
      open(uri, change.scope);
      const item = sidebar.findFile(uri, change.scope);
      if (item) await viewFor(change.scope).reveal(item, { select: true, focus: false });
    }),
    vscode.commands.registerCommand("universal_diff_viewer.refresh", async () => {
      try {
        statistics.retryUnavailable();
        await sidebar.refresh();
      } catch (error) {
        await vscode.window.showErrorMessage(
          `Universal Diff Viewer: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }),
    vscode.window.registerWebviewPanelSerializer(viewType, {
      async deserializeWebviewPanel(panel) {
        attach(panel);
      },
    }),
  );
}
