"use strict";

/*
 * Tags View
 *
 * Our own Tags pane, built to behave like the core one: a tree of every tag in
 * the vault with its count, four sort orders, nested tags on or off, collapse
 * and expand all, a filter box, and click-to-search. The search opens in a
 * pane of its own below the tags (see the plugin class).
 *
 * The difference: tags listed under Settings → Tags View → Hidden tags never
 * appear. The notes are not touched — the tags stay in the files, in search,
 * and in autocomplete. Hiding a tag hides the tags nested under it too.
 *
 * Rows reuse the core pane's classes (tree-item, tag-pane-tag, ...) so the
 * theme and Obsidian's own stylesheet draw them the same way.
 */

const {
  Plugin,
  ItemView,
  PluginSettingTab,
  Setting,
  SearchComponent,
  Menu,
  setIcon,
  setTooltip,
  debounce,
} = require("obsidian");

const VIEW_TYPE = "tags-view";
const SEARCH_PANE_CLASS = "tags-view-search-pane";

const DEFAULT_SETTINGS = {
  hiddenTags: ["excalidraw", "copilot-conversation"],
  folds: [],
};

const SORTS = [
  ["alphabetical", "Tag name (A to Z)"],
  ["alphabeticalReverse", "Tag name (Z to A)"],
  null,
  ["frequency", "Frequency (high to low)"],
  ["frequencyReverse", "Frequency (low to high)"],
];

/* "#Foo/Bar" and "foo/bar" are the same tag to Obsidian. */
function normalize(tag) {
  return tag.trim().replace(/^#+/, "").toLowerCase();
}

/* Core's slide: height, vertical padding and margin run between their natural
   size and zero over 100ms on the same curve, with the overflow clipped. A
   click during a running slide reverses from wherever it has got to. */
const SLIDE_PROPS = ["height", "paddingTop", "paddingBottom", "marginTop", "marginBottom"];
function slide(el, open) {
  const running = el.getAnimations();
  const from = {};
  el.show();
  if (running.length) {
    const style = getComputedStyle(el);
    for (const p of SLIDE_PROPS) from[p] = style[p];
    running.forEach((a) => a.cancel());
  }
  const style = getComputedStyle(el);
  const full = {};
  for (const p of SLIDE_PROPS) full[p] = style[p];
  const zero = {};
  for (const p of SLIDE_PROPS) zero[p] = "0px";

  const start = running.length ? from : open ? zero : full;
  const end = open ? full : zero;
  const anim = el.animate([{ ...start, overflowY: "clip" }, { ...end, overflowY: "clip" }], {
    duration: 100,
    easing: "cubic-bezier(.02, .01, .47, 1)",
  });
  anim.onfinish = () => {
    if (!open) el.hide();
  };
}

const collator =new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

class TagsView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.icon = "lucide-tags";
    this.sortOrder = "frequency";
    this.useHierarchy = true;
    this.showSearch = false;
    this.query = "";
    this.nodes = [];
  }

  getViewType() {
    return VIEW_TYPE;
  }

  getDisplayText() {
    return "Tags";
  }

  getState() {
    return {
      sortOrder: this.sortOrder,
      useHierarchy: this.useHierarchy,
      showSearch: this.showSearch,
      searchQuery: this.query,
    };
  }

  async setState(state, result) {
    if (state) {
      if (SORTS.some((s) => s && s[0] === state.sortOrder)) this.sortOrder = state.sortOrder;
      if (typeof state.useHierarchy === "boolean") this.useHierarchy = state.useHierarchy;
      if (typeof state.searchQuery === "string") this.query = state.searchQuery;
      if (typeof state.showSearch === "boolean") this.showSearch = state.showSearch;
    }
    this.syncHeader();
    this.render();
    await super.setState(state, result);
  }

  async onOpen() {
    const root = this.containerEl;
    root.empty();

    /* The header: same buttons, same order, same icons as the core pane. */
    const header = root.createDiv("nav-header");
    const buttons = header.createDiv("nav-buttons-container");
    const button = (icon, label, onClick) => {
      const el = buttons.createDiv({ cls: "clickable-icon nav-action-button" });
      setIcon(el, icon);
      setTooltip(el, label);
      el.addEventListener("click", onClick);
      return el;
    };

    button("lucide-sort-asc", "Change sort order", (evt) => {
      const menu = new Menu();
      for (const sort of SORTS) {
        if (!sort) {
          menu.addSeparator();
          continue;
        }
        menu.addItem((item) =>
          item
            .setTitle(sort[1])
            .setChecked(sort[0] === this.sortOrder)
            .onClick(() => {
              this.sortOrder = sort[0];
              this.render();
              this.app.workspace.requestSaveLayout();
            })
        );
      }
      menu.showAtMouseEvent(evt);
    });

    this.hierarchyEl = button("lucide-folder-tree", "Show nested tags", () => {
      this.useHierarchy = !this.useHierarchy;
      this.syncHeader();
      this.render();
      this.app.workspace.requestSaveLayout();
    });

    this.collapseEl = button("lucide-chevrons-up-down", "Expand all", () => {
      if (!this.useHierarchy) return;
      this.setAllCollapsed(!this.allCollapsed());
    });

    this.searchButtonEl = button("lucide-search", "Show search filter", () => {
      this.showSearch = !this.showSearch;
      if (!this.showSearch) this.query = "";
      this.syncHeader();
      this.applyFilter();
      if (this.showSearch) this.search.inputEl.focus();
      this.app.workspace.requestSaveLayout();
    });

    this.search = new SearchComponent(header).setPlaceholder("Search...");
    this.search.onChange(
      debounce(
        (value) => {
          this.query = value;
          this.applyFilter();
          this.app.workspace.requestSaveLayout();
        },
        300,
        true
      )
    );

    this.listEl = root.createDiv("tag-container tags-view-container");

    this.registerEvent(this.app.metadataCache.on("resolved", () => this.requestRender()));
    this.registerEvent(this.app.metadataCache.on("changed", () => this.requestRender()));

    this.syncHeader();
    this.render();
  }

  requestRender() {
    if (!this.debouncedRender) this.debouncedRender = debounce(() => this.render(), 300, true);
    this.debouncedRender();
  }

  syncHeader() {
    if (!this.hierarchyEl) return;
    this.hierarchyEl.toggleClass("is-active", this.useHierarchy);
    this.collapseEl.setAttr("aria-disabled", String(!this.useHierarchy));
    this.searchButtonEl.toggleClass("is-active", this.showSearch);
    this.search.containerEl.toggle(this.showSearch);
    if (this.search.getValue() !== this.query) this.search.setValue(this.query);
    this.syncCollapseButton();
  }

  /* Build the tree: one node per tag, keyed by lower case path. With nested
     tags on, "a/b" hangs under "a", and a parent that nobody tagged directly
     is created as a plain branch. */
  buildTree() {
    const counts = this.app.metadataCache.getTags();
    const hidden = this.plugin.settings.hiddenTags;
    const isHidden = (tag) => {
      const t = normalize(tag);
      return hidden.some((h) => t === h || t.startsWith(h + "/"));
    };

    const byKey = new Map();
    const roots = [];
    const make = (tag) => {
      const key = normalize(tag);
      let node = byKey.get(key);
      if (!node) {
        node = { tag, key, count: counts[tag] || 0, children: [] };
        byKey.set(key, node);
      }
      return node;
    };
    const attach = (node) => {
      const path = node.tag.replace(/^#/, "");
      const cut = path.lastIndexOf("/");
      if (this.useHierarchy && cut > 0) {
        const parent = make("#" + path.slice(0, cut));
        if (!parent.children.includes(node)) parent.children.push(node);
        attach(parent);
      } else if (!roots.includes(node)) {
        roots.push(node);
      }
    };

    for (const tag of Object.keys(counts)) {
      if (!isHidden(tag)) attach(make(tag));
    }
    return roots;
  }

  compare() {
    const byName = (a, b) => collator.compare(a.tag, b.tag);
    switch (this.sortOrder) {
      case "alphabetical":
        return byName;
      case "alphabeticalReverse":
        return (a, b) => -byName(a, b);
      default: {
        const dir = this.sortOrder === "frequencyReverse" ? -1 : 1;
        return (a, b) => (a.count === b.count ? byName(a, b) : dir * (b.count - a.count));
      }
    }
  }

  render() {
    if (!this.listEl) return;
    const scroll = this.listEl.scrollTop;
    this.listEl.empty();
    this.nodes = [];

    const roots = this.buildTree();
    if (!roots.length) {
      this.listEl.createDiv({ cls: "pane-empty tag-pane-empty", text: "No tags found." });
      this.syncCollapseButton();
      return;
    }

    const folds = new Set(this.plugin.settings.folds);
    const sort = this.compare();
    const draw = (node, parentEl, depth) => {
      const itemEl = parentEl.createDiv("tree-item");
      const selfEl = itemEl.createDiv("tree-item-self tag-pane-tag is-clickable");
      /* Same indentation the core pane writes inline. The base is a variable
         so sidebar-insets.css can set where the first column starts. */
      selfEl.style.setProperty("margin-inline-start", `${-17 * depth}px`, "important");
      selfEl.style.setProperty("padding-inline-start", `calc(var(--tree-row-start, 24px) + ${17 * depth}px)`, "important");

      const hasChildren = node.children.length > 0;
      if (hasChildren) {
        selfEl.addClass("mod-collapsible");
        const iconEl = (node.iconEl = selfEl.createDiv("tree-item-icon collapse-icon"));
        setIcon(iconEl, "right-triangle");
        iconEl.addEventListener("click", (evt) => {
          evt.stopPropagation();
          this.setCollapsed(node, !node.collapsed, true);
          this.plugin.saveFolds(this.nodes);
        });
      }

      const textEl = selfEl.createDiv("tree-item-inner").createDiv("tree-item-inner-text");
      const path = node.tag.replace(/^#/, "");
      const name = path.split("/").pop();
      textEl.createSpan({ cls: "tag-pane-tag-parent", text: path.slice(0, path.length - name.length) });
      textEl.createSpan({ cls: "tree-item-inner-text", text: name });
      selfEl
        .createDiv("tree-item-flair-outer")
        .createSpan({ cls: "tag-pane-tag-count tree-item-flair", text: String(node.count) });

      selfEl.addEventListener("click", () => this.openSearch(node.tag));

      node.itemEl = itemEl;
      node.selfEl = selfEl;
      node.childrenEl = itemEl.createDiv("tree-item-children");
      this.nodes.push(node);

      node.children.sort(sort);
      for (const child of node.children) draw(child, node.childrenEl, depth + 1);
      if (hasChildren) this.setCollapsed(node, folds.has(node.key));
    };

    roots.sort(sort);
    for (const node of roots) draw(node, this.listEl, 0);

    this.applyFilter();
    this.syncCollapseButton();
    this.listEl.scrollTop = scroll;
  }

  /* Obsidian's stylesheet turns the triangle only when the icon itself carries
     is-collapsed, so the class goes on both the row and the icon, as in core. */
  setCollapsed(node, collapsed, animate = false) {
    node.collapsed = collapsed;
    node.itemEl.toggleClass("is-collapsed", collapsed);
    node.iconEl.toggleClass("is-collapsed", collapsed);
    if (animate) slide(node.childrenEl, !collapsed);
    else node.childrenEl.toggle(!collapsed);
    this.syncCollapseButton();
  }

  collapsible() {
    return this.nodes.filter((n) => n.children.length);
  }

  allCollapsed() {
    const nodes = this.collapsible();
    return nodes.length > 0 && nodes.every((n) => n.collapsed);
  }

  setAllCollapsed(collapsed) {
    for (const node of this.collapsible()) {
      if (node.collapsed !== collapsed) this.setCollapsed(node, collapsed, true);
    }
    this.plugin.saveFolds(this.nodes);
  }

  syncCollapseButton() {
    if (!this.collapseEl) return;
    const collapsed = this.allCollapsed();
    setIcon(this.collapseEl, collapsed ? "lucide-chevrons-up-down" : "lucide-chevrons-down-up");
    setTooltip(this.collapseEl, collapsed ? "Expand all" : "Collapse all");
  }

  /* Every word in the box must appear in the tag. A tag that matches keeps
     its parents visible so it still sits where it belongs. */
  applyFilter() {
    const words = this.query.toLowerCase().split(/\s+/).filter(Boolean);
    for (const node of this.nodes) node.itemEl.toggleClass("is-filtered-out", words.length > 0);
    if (!words.length) return;
    for (const node of this.nodes) {
      const tag = node.key;
      if (!words.every((w) => tag.includes(w))) continue;
      for (let el = node.itemEl; el && el !== this.listEl; el = el.parentElement) {
        el.removeClass("is-filtered-out");
      }
    }
  }

  /* Click: search for the tag. The search runs in this plugin's own pane
     under the tags, not in core's search tab, which would take over the File
     Explorer's place on the left. */
  openSearch(tag) {
    this.plugin.showSearch("tag:" + tag, this.leaf);
  }


}

class TagsViewSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName("Hidden tags")
      .setDesc("These tags, and any tags nested under them, never appear in the Tags view. Your notes are not changed.")
      .setHeading();

    let draft = "";
    const add = async () => {
      const tag = normalize(draft);
      if (!tag || this.plugin.settings.hiddenTags.includes(tag)) return;
      this.plugin.settings.hiddenTags.push(tag);
      await this.plugin.saveSettings();
      this.display();
    };

    new Setting(containerEl)
      .setName("Add a tag to hide")
      .setDesc("With or without the #.")
      .addText((text) => {
        text.setPlaceholder("#tag").onChange((value) => (draft = value));
        text.inputEl.addEventListener("keydown", (evt) => {
          if (evt.key === "Enter") add();
        });
      })
      .addButton((btn) => btn.setButtonText("Hide").setCta().onClick(add));

    for (const tag of this.plugin.settings.hiddenTags) {
      new Setting(containerEl).setName("#" + tag).addExtraButton((btn) =>
        btn
          .setIcon("lucide-x")
          .setTooltip("Show this tag again")
          .onClick(async () => {
            this.plugin.settings.hiddenTags = this.plugin.settings.hiddenTags.filter((t) => t !== tag);
            await this.plugin.saveSettings();
            this.display();
          })
      );
    }
  }
}

module.exports = class TagsViewPlugin extends Plugin {
  async onload() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());

    this.registerView(VIEW_TYPE, (leaf) => new TagsView(leaf, this));
    this.addCommand({
      id: "open",
      name: "Open tags view",
      icon: "lucide-tags",
      callback: () => this.activate(),
    });
    this.addSettingTab(new TagsViewSettingTab(this.app, this));

    /* The search pane is re-found after a restart, and re-marked whenever the
       layout is rebuilt, so its tab bar stays hidden. */
    this.app.workspace.onLayoutReady(() => this.syncSearchPane());
    this.registerEvent(this.app.workspace.on("layout-change", () => this.syncSearchPane()));
    /* Switching sidebar tabs is an active-leaf change, not a layout one. */
    this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.syncSearchPane()));

    this.app.workspace.onLayoutReady(() => this.catchTagClicks());
  }

  /* --- Tag clicks anywhere in the vault ------------------------------------
     A tag clicked in a note (editor, reading view, the Properties box), in
     the graph or on a canvas all end in one call: the global-search plugin's
     openGlobalSearch("tag:" + tag). Read from the 1.13.7 asar. So that one
     call is wrapped, on the plugin instance: a search for a single tag opens
     Tags View and runs in its pane; every other search (Cmd+Shift+F, "search
     in folder", a multi-term query) goes to core untouched.

     The wrapper is only unwound if it is still the outermost one, and it goes
     inert once this plugin unloads, the same guard Hide Files uses. */
  catchTagClicks() {
    const search = this.app.internalPlugins.getEnabledPluginById("global-search");
    if (!search || this.searchPlugin) return;
    this.searchPlugin = search;
    this.originalOpenSearch = search.openGlobalSearch;
    const original = this.originalOpenSearch;
    const plugin = this;
    this.openSearchWrapper = function (query, ...rest) {
      const tag = plugin._loaded && typeof query === "string" && /^tag:#?([^\s#"]+)$/.exec(query.trim());
      if (tag) {
        plugin.openTagSearch("#" + tag[1]);
        return;
      }
      return original.call(this, query, ...rest);
    };
    search.openGlobalSearch = this.openSearchWrapper;
  }

  releaseTagClicks() {
    const search = this.searchPlugin;
    if (search && search.openGlobalSearch === this.openSearchWrapper) {
      search.openGlobalSearch = this.originalOpenSearch;
    }
    this.searchPlugin = null;
  }

  /* Bring Tags View forward in its own tab group (opening it if it was
     closed), then run the search in the pane below it. Tags View first: its
     pane closes whenever Tags View is not the tab showing. */
  async openTagSearch(tag) {
    const leaf = await this.activate();
    if (leaf) await this.showSearch("tag:" + tag, leaf);
  }

  /* The search pane belongs to Tags View: the moment Tags View is not the tab
     showing in its group (another tab chosen, or Tags View closed), the pane
     closes. A collapsed sidebar hides both together, so that is left alone. */
  syncSearchPane() {
    const leaf = this.findSearchLeaf();
    if (!leaf) return;
    const tags = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0];
    const group = tags && tags.parent;
    const showing = group && group.children[group.currentTab] === tags;
    if (!showing) this.closeSearch();
  }

  onunload() {
    this.releaseTagClicks();
    document.querySelectorAll("." + SEARCH_PANE_CLASS).forEach((el) => el.removeClass(SEARCH_PANE_CLASS));
  }

  /* --- The search pane -----------------------------------------------------
     Core's tag search goes through openGlobalSearch, which is
     ensureSideLeaf("search", "left"): it reuses the first search leaf it
     finds, or makes one on the left. So it always lands on top of the File
     Explorer. Instead, Tags View keeps a search leaf of its own in a tab group
     split off below its own, with the tab bar hidden. It is an ordinary core
     search view, so results, filters and clicks all behave as usual. The left
     Search tab and Cmd+Shift+F are left alone.

     The × in its results row closes the pane, and the Tags view gets its full
     height back. */

  findSearchLeaf() {
    const workspace = this.app.workspace;
    const leaf = this.searchLeaf;
    if (leaf && leaf.parent && leaf.view && leaf.view.getViewType() === "search") {
      this.adopt(leaf);
      return leaf;
    }
    this.searchLeaf = null;
    /* After a restart: a right-sidebar tab group holding nothing but a search
       leaf is this pane. */
    for (const candidate of workspace.getLeavesOfType("search")) {
      if (candidate.getRoot() === workspace.rightSplit && candidate.parent.children.length === 1) {
        this.adopt(candidate);
        return candidate;
      }
    }
    return null;
  }

  adopt(leaf) {
    this.searchLeaf = leaf;
    leaf.parent.containerEl.addClass(SEARCH_PANE_CLASS);
    this.addCloseButton(leaf);
  }

  /* Clicks are queued: a second click while the pane is still being built
     would otherwise find no pane yet and split a second one. */
  showSearch(query, anchor) {
    this.searchQueue = (this.searchQueue || Promise.resolve())
      .then(() => this.runSearch(query, anchor))
      .catch((e) => console.error(e));
    return this.searchQueue;
  }

  async runSearch(query, anchor) {
    if (!query) {
      this.closeSearch();
      return;
    }
    const workspace = this.app.workspace;
    let leaf = this.findSearchLeaf();
    /* A new pane sorts by created time, newest first. An open one keeps
       whatever sort was picked in it, so the next tag clicked does not undo
       the choice. */
    const sortOrder = leaf ? leaf.getViewState().state.sortOrder : "byCreatedTime";
    if (!leaf) leaf = workspace.createLeafBySplit(anchor, "horizontal", false);
    /* Results always start collapsed, and the toggles styles.css hides are
       pinned off, so a hidden setting can never be silently on. */
    await leaf.setViewState({
      type: "search",
      state: { query, sortOrder, collapseAll: true, matchingCase: false, explainSearch: false, extraContext: false },
      active: false,
    });
    this.adopt(leaf);
    await workspace.revealLeaf(leaf);
  }

  closeSearch() {
    const leaf = this.findSearchLeaf();
    this.searchLeaf = null;
    if (leaf) leaf.detach();
  }

  /* The pane only ever shows a tag search, so styles.css hides the search
     box, and the × that cleared it moves into the results row: count on the
     left, sort in the middle, close on the right. The row is built once with
     the view and only its text changes after that, so a button appended to it
     stays put. */
  addCloseButton(leaf) {
    const row = leaf.view && leaf.view.containerEl && leaf.view.containerEl.querySelector(".search-results-info");
    if (!row || row.querySelector(".tags-view-search-close")) return;
    const button = row.createDiv({ cls: "clickable-icon tags-view-search-close" });
    setIcon(button, "lucide-x");
    setTooltip(button, "Close search");
    button.addEventListener("click", () => this.closeSearch());
  }


  async activate() {
    const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0];
    if (existing) {
      await this.app.workspace.revealLeaf(existing);
      return existing;
    }
    const leaf = this.app.workspace.getRightLeaf(false);
    await leaf.setViewState({ type: VIEW_TYPE, active: true });
    await this.app.workspace.revealLeaf(leaf);
    return leaf;
  }

  async saveSettings() {
    await this.saveData(this.settings);
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
      if (leaf.view instanceof TagsView) leaf.view.render();
    }
  }

  /* Folds are remembered across views and restarts, keyed by tag path. Folds
     for tags not currently drawn are kept, so turning nested tags off and on
     again does not forget them. */
  saveFolds(nodes) {
    const drawn = new Set(nodes.map((n) => n.key));
    const kept = this.settings.folds.filter((k) => !drawn.has(k));
    for (const n of nodes) if (n.children.length && n.collapsed) kept.push(n.key);
    this.settings.folds = kept;
    this.saveData(this.settings);
  }
};
