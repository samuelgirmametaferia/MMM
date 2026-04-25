document.addEventListener("DOMContentLoaded", async () => {
    const createWindowId = () => {
        if (window.crypto && typeof window.crypto.randomUUID === "function") {
            return window.crypto.randomUUID();
        }
        return `mmmw-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    };

    if (window.MJSI && window.MJSI.ready) {
        try {
            await window.MJSI.ready;
        } catch (_err) {
            // Continue with local fallback if native bootstrap fails.
        }
    }

    const parseLocalJSON = (key, fallback) => {
        try {
            return JSON.parse(localStorage.getItem(key) || JSON.stringify(fallback));
        } catch (_err) {
            return fallback;
        }
    };

    const DEBUG_LOG_KEY = "mmm-debug-log-v1";

    function summarizeForLog(value, depth = 2) {
        if (depth <= 0) {
            if (typeof value === "string") return value.length > 240 ? `${value.slice(0, 240)}…(${value.length})` : value;
            if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
            if (Array.isArray(value)) return { type: "array", size: value.length };
            if (value && typeof value === "object") return { type: "object", keys: Object.keys(value).length };
            return { type: typeof value };
        }

        if (typeof value === "string") return value.length > 1200 ? `${value.slice(0, 1200)}…(${value.length})` : value;
        if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
        if (Array.isArray(value)) return { type: "array", size: value.length, head: value.slice(0, 8).map((v) => summarizeForLog(v, depth - 1)) };
        if (value && typeof value === "object") {
            const out = {};
            const keys = Object.keys(value);
            keys.slice(0, 12).forEach((k) => {
                out[k] = summarizeForLog(value[k], depth - 1);
            });
            if (keys.length > 12) out.__moreKeys = keys.length - 12;
            return out;
        }
        return { type: typeof value };
    }

    function appendLocalDebugLog(entry) {
        try {
            const list = parseLocalJSON(DEBUG_LOG_KEY, []);
            if (!Array.isArray(list)) return;
            list.push(entry);
            if (list.length > 500) list.splice(0, list.length - 500);
            localStorage.setItem(DEBUG_LOG_KEY, JSON.stringify(list));
        } catch (_err) {
        }
    }

    let logWindowId = "";

    function nativeLog(level, event, data = null, message = "") {
        const entry = {
            ts: new Date().toISOString(),
            level: String(level || "info"),
            event: String(event || ""),
            windowId: logWindowId,
            message: message ? String(message).slice(0, 2000) : "",
            data: data ? summarizeForLog(data, 2) : null
        };

        appendLocalDebugLog(entry);

        const host = window.mmmHost;
        if (host && typeof host.invoke === "function") {
            host.invoke("log.write", {
                level: entry.level,
                source: "ui",
                event: entry.event,
                message: entry.message,
                data: entry.data
            }).catch(() => {
                // Keep local log only.
            });
        }
    }

    const state = {
        currentPath: ["Home"],
        viewMode: localStorage.getItem("mmm-view") || "grid",
        sidebarCollapsed: localStorage.getItem("mmm-sidebar") === "collapsed",
        theme: localStorage.getItem("mmm-theme") || "dark",
        activeView: document.body.dataset.view || "explorer",
        split: false,
        previewVisible: true,
        selection: new Set(),
        anchorIndex: null,
        items: [],
        dirNextCursor: {},
        dirLoading: false,
        dirLastError: null,
        tabs: ["/Home"],
        activeTab: 0,
        customLocations: [],
        shortcuts: {
            spotlight: localStorage.getItem("mmm-shortcut-spotlight") || "Ctrl+K",
            newTab: localStorage.getItem("mmm-shortcut-newtab") || "Ctrl+T",
            newFolder: localStorage.getItem("mmm-shortcut-newfolder") || "Ctrl+N",
            newFile: localStorage.getItem("mmm-shortcut-newfile") || "Ctrl+Shift+N",
            refresh: localStorage.getItem("mmm-shortcut-refresh") || "Ctrl+R",
            togglePreview: localStorage.getItem("mmm-shortcut-preview") || "Ctrl+P",
            back: localStorage.getItem("mmm-shortcut-back") || "Alt+ArrowLeft",
            forward: localStorage.getItem("mmm-shortcut-forward") || "Alt+ArrowRight",
            copy: localStorage.getItem("mmm-shortcut-copy") || "Ctrl+C",
            cut: localStorage.getItem("mmm-shortcut-cut") || "Ctrl+X",
            paste: localStorage.getItem("mmm-shortcut-paste") || "Ctrl+V",
            undo: localStorage.getItem("mmm-shortcut-undo") || "Ctrl+Z",
            redo: localStorage.getItem("mmm-shortcut-redo") || "Ctrl+Y",
            rename: localStorage.getItem("mmm-shortcut-rename") || "F2",
            del: localStorage.getItem("mmm-shortcut-delete") || "Delete",
            selectAll: localStorage.getItem("mmm-shortcut-selectall") || "Ctrl+A",
            duplicate: localStorage.getItem("mmm-shortcut-duplicate") || "Ctrl+D",
            toggleHistory: localStorage.getItem("mmm-shortcut-history") || "Ctrl+H",
            toggleTerminal: localStorage.getItem("mmm-shortcut-terminal") || "Ctrl+`"
        },
        draggedItemIndex: null,
        isDragging: false,
        suppressClickUntil: 0,
        menuScope: "item",
        fileRegionContextBound: false,
        clipboard: {
            mode: null,
            sourcePath: "",
            items: []
        },
        folderIconRules: parseLocalJSON("mmm-folder-icon-rules", {}),
        fileIconRules: parseLocalJSON("mmm-file-icon-rules", {}),
        contextExpanded: localStorage.getItem("mmm-context-expanded") === "1",
        contextActionConfig: parseLocalJSON("mmm-context-actions", {}),
        customContextActions: parseLocalJSON("mmm-custom-context-actions", []),
        ioHistory: {
            undoStack: [],
            redoStack: []
        },
        ioTimeline: [],
        ioTimelineIndex: -1,
        ioHistoryEnabled: localStorage.getItem("mmm-io-history-enabled") !== "0",
        ioHistoryLimit: Number(localStorage.getItem("mmm-io-history-limit") || "140"),
        ioTimelineLimit: Number(localStorage.getItem("mmm-io-timeline-limit") || "140"),
        recycleRetentionDays: Number(localStorage.getItem("mmm-recycle-retention-days") || "30"),
        recycleMaxItems: Number(localStorage.getItem("mmm-recycle-max-items") || "1000"),
        sidebarIconRules: parseLocalJSON("mmm-sidebar-icon-rules", {}),
        navHistory: parseLocalJSON("mmm-nav-history", []),
        navHistoryIndex: Number(localStorage.getItem("mmm-nav-history-index") || "-1"),
        operationQueue: [],
        operationQueueBusy: false,
        operationQueuePaused: false,
        terminalVisible: false,
        terminalLines: ["MMM terminal ready. Type 'help' for commands."],
        terminalHistory: [],
        terminalHistoryIndex: -1,
        terminalBusy: false,
        popupFadeTimer: null,
        popupHideTimer: null,
        draggedSourcePath: "",
        draggedIndices: [],
        dragPayload: null,
        dragKind: null,
        shiftHeld: false,
        draggedTabIndex: null,
        draggedFavoriteIndex: null,
        customIcons: parseLocalJSON("mmm-custom-icons", {}),
        windowId: createWindowId()
    };

    logWindowId = state.windowId;
    nativeLog("info", "ui.init", { view: state.activeView, windowId: state.windowId, href: window.location.href });

    const fileSystem = {
        "/Home": [
            { name: "workspace", type: "folder", modified: "2026-04-15", size: "--", git: "modified" },
            { name: "Downloads", type: "folder", modified: "2026-04-15", size: "--", git: "untracked" },
            { name: "Pictures", type: "folder", modified: "2026-04-15", size: "--", git: "ignored" },
            { name: "Network Bin", type: "folder", modified: "2026-04-15", size: "--", git: "untracked" }
        ],
        "/Home/workspace": [
            { name: "src", type: "folder", modified: "2026-04-15", size: "--", git: "modified" },
            { name: "docs", type: "folder", modified: "2026-04-14", size: "--", git: "untracked" },
            { name: "README.md", type: "file", ext: "md", modified: "2026-04-13", size: "2 KB", git: "ignored" },
            { name: "package.json", type: "file", ext: "json", modified: "2026-04-13", size: "1 KB", git: "modified" }
        ],
        "/Home/workspace/src": [
            { name: "app", type: "folder", modified: "2026-04-15", size: "--", git: "modified" },
            { name: "components", type: "folder", modified: "2026-04-14", size: "--", git: "untracked" },
            { name: "styles", type: "folder", modified: "2026-04-14", size: "--", git: "ignored" },
            { name: "main.js", type: "file", ext: "js", modified: "2026-04-15", size: "4 KB", git: "modified" },
            { name: "index.html", type: "file", ext: "html", modified: "2026-04-13", size: "3 KB", git: "untracked" },
            { name: "notes.md", type: "file", ext: "md", modified: "2026-04-12", size: "2 KB", git: "ignored" },
            { name: "logo.png", type: "file", ext: "png", modified: "2026-04-11", size: "90 KB", git: "modified" },
            { name: "server.ts", type: "file", ext: "ts", modified: "2026-04-10", size: "7 KB", git: "untracked" }
        ],
        "/Home/workspace/src/components": [
            { name: "Sidebar.ts", type: "file", ext: "ts", modified: "2026-04-15", size: "3 KB", git: "modified" },
            { name: "Toolbar.ts", type: "file", ext: "ts", modified: "2026-04-15", size: "2 KB", git: "untracked" },
            { name: "Spotlight.ts", type: "file", ext: "ts", modified: "2026-04-13", size: "3 KB", git: "ignored" }
        ],
        "/Home/Downloads": [
            { name: "archive.zip", type: "file", ext: "zip", modified: "2026-04-10", size: "120 KB", git: "ignored" },
            { name: "report.pdf", type: "file", ext: "pdf", modified: "2026-04-11", size: "1.2 MB", git: "untracked" }
        ],
        "/Home/Pictures": [
            { name: "wallpaper.png", type: "file", ext: "png", modified: "2026-04-08", size: "2.3 MB", git: "ignored" },
            { name: "draft.jpg", type: "file", ext: "jpg", modified: "2026-04-05", size: "820 KB", git: "untracked" }
        ],
        "/Home/Network Bin": [],
        "/Home/Recycle Bin": []
    };

    const els = {
        explorerPanel: document.getElementById("explorerPanel"),
        settingsPanel: document.getElementById("settingsPanel"),
        propertiesPanel: document.getElementById("propertiesPanel"),
        fileRegion: document.getElementById("fileRegion"),
        previewPane: document.getElementById("previewPane"),
        previewBody: document.getElementById("previewBody"),
        previewToggle: document.getElementById("previewToggle"),
        breadcrumbs: document.getElementById("breadcrumbs"),
        addressBar: document.getElementById("addressBar"),
        pathInput: document.getElementById("pathInput"),
        spotlight: document.getElementById("spotlight"),
        spotlightInput: document.getElementById("spotlightInput"),
        spotlightResults: document.getElementById("spotlightResults"),
        contextMenu: document.getElementById("contextMenu"),
        cwdLabel: document.getElementById("cwdLabel"),
        propertiesTable: document.getElementById("propertiesTable"),
        viewModeToggle: document.getElementById("viewModeToggle"),
        tabStrip: document.getElementById("tabStrip"),
        topDropArea: document.getElementById("topDropArea"),
        favorites: document.getElementById("favorites"),
        workspace: document.getElementById("workspace"),
        themeToggle: document.getElementById("themeToggle"),
        sidebarToggle: document.getElementById("sidebarToggle"),
        addLocationBtn: document.getElementById("addLocationBtn"),
        newTabBtn: document.getElementById("newTabBtn"),
        newWindowBtn: document.getElementById("newWindowBtn"),
        newFileBtn: document.getElementById("newFileBtn"),
        previewPaneToggle: document.getElementById("previewPaneToggle"),
        newFolderDialog: document.getElementById("newFolderDialog"),
        newFolderNameInput: document.getElementById("newFolderNameInput"),
        newFolderCancelBtn: document.getElementById("newFolderCancelBtn"),
        newFolderCreateBtn: document.getElementById("newFolderCreateBtn"),
        newFileDialog: document.getElementById("newFileDialog"),
        newFileNameInput: document.getElementById("newFileNameInput"),
        newFileCancelBtn: document.getElementById("newFileCancelBtn"),
        newFileCreateBtn: document.getElementById("newFileCreateBtn"),
        contextExpandedCheckbox: document.getElementById("contextExpandedCheckbox"),
        contextActionsInput: document.getElementById("contextActionsInput"),
        saveContextActionsBtn: document.getElementById("saveContextActionsBtn"),
        customContextActionsInput: document.getElementById("customContextActionsInput"),
        saveCustomContextActionsBtn: document.getElementById("saveCustomContextActionsBtn"),
        addTemplateVsCodeBtn: document.getElementById("addTemplateVsCodeBtn"),
        addTemplateTerminalBtn: document.getElementById("addTemplateTerminalBtn"),
        addTemplateBrowserBtn: document.getElementById("addTemplateBrowserBtn"),
        fileIconRulesInput: document.getElementById("fileIconRulesInput"),
        saveFileIconRulesBtn: document.getElementById("saveFileIconRulesBtn"),
        sidebarIconRulesInput: document.getElementById("sidebarIconRulesInput"),
        saveSidebarIconRulesBtn: document.getElementById("saveSidebarIconRulesBtn"),
        historyToggleBtn: document.getElementById("historyToggleBtn"),
        historyPanel: document.getElementById("historyPanel"),
        historyCloseBtn: document.getElementById("historyCloseBtn"),
        historyList: document.getElementById("historyList"),
        historyDiff: document.getElementById("historyDiff"),
        operationPopup: document.getElementById("operationPopup"),
        operationPopupTitle: document.getElementById("operationPopupTitle"),
        operationPopupBody: document.getElementById("operationPopupBody"),
        operationUndoBtn: document.getElementById("operationUndoBtn"),
        operationRedoBtn: document.getElementById("operationRedoBtn"),
        operationPopupCloseBtn: document.getElementById("operationPopupCloseBtn"),
        terminalPane: document.getElementById("terminalPane"),
        terminalLauncherBtn: document.getElementById("terminalLauncherBtn"),
        terminalOutput: document.getElementById("terminalOutput"),
        terminalInput: document.getElementById("terminalInput"),
        terminalRunBtn: document.getElementById("terminalRunBtn"),
        terminalResizer: document.getElementById("terminalResizer"),
        ioHistoryEnabledCheckbox: document.getElementById("ioHistoryEnabledCheckbox"),
        ioHistoryLimitInput: document.getElementById("ioHistoryLimitInput"),
        ioTimelineLimitInput: document.getElementById("ioTimelineLimitInput"),
        recycleRetentionDaysInput: document.getElementById("recycleRetentionDaysInput"),
        recycleMaxItemsInput: document.getElementById("recycleMaxItemsInput"),
        queuePauseBtn: document.getElementById("queuePauseBtn"),
        queueClearBtn: document.getElementById("queueClearBtn"),
        iconImportKeyInput: document.getElementById("iconImportKeyInput"),
        iconImportFileInput: document.getElementById("iconImportFileInput"),
        importIconFileBtn: document.getElementById("importIconFileBtn"),
        iconImportSvgInput: document.getElementById("iconImportSvgInput"),
        importIconSvgBtn: document.getElementById("importIconSvgBtn"),
        importedIconsList: document.getElementById("importedIconsList"),
        sysVirtualRoot: document.getElementById("sysVirtualRoot"),
        sysRealRoot: document.getElementById("sysRealRoot"),
        sysApplyRootBtn: document.getElementById("sysApplyRootBtn"),
        sysResetRootBtn: document.getElementById("sysResetRootBtn"),
        sysRefreshInfoBtn: document.getElementById("sysRefreshInfoBtn"),
        sysInfoOutput: document.getElementById("sysInfoOutput")
    };

    const tabDragUI = {
        active: false,
        dropped: false,
        detachTriggered: false,
        path: "",
        sourceWindowId: "",
        dropIndex: null,
        ghost: null,
        indicator: null,
        detachHint: null
    };

    const CROSS_WINDOW_TAB_DRAG_KEY = "mmm-cross-window-tab-drag";
    const CROSS_WINDOW_TAB_DRAG_TTL_MS = 12000;

    function ensureTabDragUI() {
        if (!tabDragUI.ghost) {
            const ghost = document.createElement("div");
            ghost.className = "tab-drag-ghost hidden";
            document.body.appendChild(ghost);
            tabDragUI.ghost = ghost;
        }

        if (els.tabStrip) {
            if (!tabDragUI.indicator) {
                const indicator = document.createElement("div");
                indicator.className = "tab-drop-indicator";
                els.tabStrip.appendChild(indicator);
                tabDragUI.indicator = indicator;
            } else if (tabDragUI.indicator.parentElement !== els.tabStrip) {
                els.tabStrip.appendChild(tabDragUI.indicator);
            }
        }

        if (!tabDragUI.detachHint) {
            const hint = document.createElement("div");
            hint.className = "tab-detach-hint";
            hint.textContent = "Drop to detach into a new window";
            document.body.appendChild(hint);
            tabDragUI.detachHint = hint;
        }
    }

    function hideTabDragUI() {
        if (tabDragUI.ghost) tabDragUI.ghost.classList.add("hidden");
        if (tabDragUI.indicator) tabDragUI.indicator.classList.remove("visible");
        if (tabDragUI.detachHint) tabDragUI.detachHint.classList.remove("visible");
        tabDragUI.active = false;
        tabDragUI.dropped = false;
        tabDragUI.detachTriggered = false;
        tabDragUI.path = "";
        tabDragUI.sourceWindowId = "";
        tabDragUI.dropIndex = null;
    }

    function isPointerOutsideTabStrip(clientX, clientY) {
        if (!els.tabStrip) return true;
        const rect = els.tabStrip.getBoundingClientRect();
        const margin = 24;
        return clientX < rect.left - margin || clientX > rect.right + margin || clientY < rect.top - margin || clientY > rect.bottom + margin;
    }

    function isTabDragEvent(e) {
        if (!e || !e.dataTransfer) return false;
        return Array.from(e.dataTransfer.types || []).includes("text/mmm-tab");
    }

    function writeCrossWindowTabDrag(path) {
        try {
            localStorage.setItem(CROSS_WINDOW_TAB_DRAG_KEY, JSON.stringify({
                sourceWindowId: state.windowId,
                path,
                ts: Date.now()
            }));
        } catch (_err) {
        }
    }

    function readCrossWindowTabDrag() {
        try {
            const raw = localStorage.getItem(CROSS_WINDOW_TAB_DRAG_KEY) || "";
            if (!raw) return null;
            const payload = JSON.parse(raw);
            if (!payload || typeof payload.path !== "string") return null;
            const ts = Number(payload.ts) || 0;
            if (!ts || (Date.now() - ts) > CROSS_WINDOW_TAB_DRAG_TTL_MS) return null;
            return {
                sourceWindowId: typeof payload.sourceWindowId === "string" ? payload.sourceWindowId : "",
                path: normalizeAbsolutePath(payload.path)
            };
        } catch (_err) {
            return null;
        }
    }

    function resolveTabDragPayload(e) {
        if (!e || !e.dataTransfer) return null;

        const raw = e.dataTransfer.getData("text/mmm-tab");
        if (raw) {
            try {
                const payload = JSON.parse(raw);
                if (payload && typeof payload.path === "string") {
                    return {
                        sourceWindowId: payload.sourceWindowId || "",
                        path: normalizeAbsolutePath(payload.path)
                    };
                }
            } catch (_err) {
            }
        }

        const types = Array.from(e.dataTransfer.types || []);
        const probablyCrossWindowTab = types.includes("text/plain") || types.includes("text/uri-list");
        if (!probablyCrossWindowTab) return null;
        return readCrossWindowTabDrag();
    }

    function computeTabDropIndex(clientX) {
        if (!els.tabStrip) return state.tabs.length;
        const tabs = Array.from(els.tabStrip.querySelectorAll(".tab"));
        for (let i = 0; i < tabs.length; i += 1) {
            const rect = tabs[i].getBoundingClientRect();
            const mid = rect.left + rect.width / 2;
            if (clientX < mid) return i;
        }
        return tabs.length;
    }

    function dedupeTabs(tabs) {
        const out = [];
        const seen = new Set();
        (tabs || []).forEach((tabPath) => {
            if (typeof tabPath !== "string") return;
            const normalized = normalizeAbsolutePath(tabPath);
            if (seen.has(normalized)) return;
            seen.add(normalized);
            out.push(normalized);
        });
        return out;
    }

    function syncTabsWithCurrentPath() {
        const current = pathToString();
        const merged = dedupeTabs(state.tabs);
        if (!merged.includes(current)) {
            merged.unshift(current);
        }
        state.tabs.splice(0, state.tabs.length, ...merged);
        const idx = state.tabs.indexOf(current);
        state.activeTab = idx === -1 ? 0 : idx;
    }

    function applyStartupPathToTabs(path) {
        const normalized = normalizeAbsolutePath(path);
        const merged = dedupeTabs(state.tabs);
        if (!merged.includes(normalized)) {
            merged.unshift(normalized);
        }
        state.tabs.splice(0, state.tabs.length, ...merged);
        state.activeTab = state.tabs.indexOf(normalized);
        if (state.activeTab < 0) state.activeTab = 0;
        setCurrentPathFromString(normalized);
    }

    function positionTabDropIndicator(index) {
        if (!els.tabStrip || !tabDragUI.indicator) return;
        const stripRect = els.tabStrip.getBoundingClientRect();
        const tabs = Array.from(els.tabStrip.querySelectorAll(".tab"));
        let leftPx = 6;
        if (tabs.length) {
            if (index <= 0) {
                leftPx = tabs[0].getBoundingClientRect().left - stripRect.left + els.tabStrip.scrollLeft;
            } else if (index >= tabs.length) {
                const lastRect = tabs[tabs.length - 1].getBoundingClientRect();
                leftPx = lastRect.right - stripRect.left + els.tabStrip.scrollLeft;
            } else {
                leftPx = tabs[index].getBoundingClientRect().left - stripRect.left + els.tabStrip.scrollLeft;
            }
        }
        tabDragUI.indicator.style.left = `${Math.max(0, Math.floor(leftPx))}px`;
        tabDragUI.indicator.classList.add("visible");
    }

    const baseContextActionDefaults = {
        open: { label: "Open", icon: "icon-folder", enabled: true },
        openNewTab: { label: "Open in New Tab", icon: "icon-plus", enabled: true },
        addFavorite: { label: "Add to Favorites", icon: "icon-folder", enabled: true },
        setFolderIcon: { label: "Set Folder Icon", icon: "icon-file", enabled: true },
        setSidebarIcon: { label: "Set Sidebar Icon", icon: "icon-sidebar", enabled: true },
        rename: { label: "Rename", icon: "icon-file", enabled: true },
        duplicate: { label: "Duplicate", icon: "icon-file", enabled: true },
        copyItem: { label: "Copy", icon: "icon-file", enabled: true },
        cutItem: { label: "Cut", icon: "icon-file", enabled: true },
        pasteItem: { label: "Paste", icon: "icon-file", enabled: true },
        moveTo: { label: "Move To Path...", icon: "icon-folder-open", enabled: true },
        copyPath: { label: "Copy Path", icon: "icon-file", enabled: true },
        properties: { label: "Properties", icon: "icon-details", enabled: true },
        newFolder: { label: "New Folder", icon: "icon-add-folder", enabled: true },
        newFile: { label: "New File", icon: "icon-file", enabled: true },
        selectAll: { label: "Select All", icon: "icon-list", enabled: true },
        undo: { label: "Undo", icon: "icon-undo", enabled: true },
        redo: { label: "Redo", icon: "icon-redo", enabled: true },
        refresh: { label: "Refresh", icon: "icon-refresh", enabled: true },
        delete: { label: "Delete", icon: "icon-trash", enabled: true },
        restoreItem: { label: "Restore from Recycle Bin", icon: "icon-restore", enabled: true },
        emptyRecycleBin: { label: "Empty Recycle Bin", icon: "icon-trash", enabled: true }
    };

    function normalizePath(path) {
        const parts = path.split("/").filter(Boolean);
        if (!parts.length || parts[0] !== "Home") {
            return ["Home", ...parts.filter((p) => p !== "Home")];
        }
        return parts;
    }

    function pathToString() {
        return `/${state.currentPath.join("/")}`;
    }

    function normalizeAbsolutePath(raw) {
        if (!raw) return "/Home";
        const clean = raw.replace(/^\/+/, "");
        const target = clean.startsWith("Home") ? `/${clean}` : `/Home/${clean}`;
        return `/${target.split("/").filter(Boolean).join("/")}`;
    }

    function isRecycleBinPath(path) {
        return normalizeAbsolutePath(path) === "/Home/Recycle Bin";
    }

    function createRecycleEntry(item, sourcePath) {
        const entry = { ...item };
        entry.deletedFrom = sourcePath;
        entry.deletedAt = new Date().toISOString();
        return entry;
    }

    async function transferItemsFromSource(items, sourcePath, targetPath, mode) {
        const issues = [];
        if (!items.length) {
            issues.push("No items selected.");
            return { moved: 0, issues };
        }
        if (!targetPath) {
            issues.push("Target path is missing.");
            return { moved: 0, issues };
        }

        const src = normalizeAbsolutePath(sourcePath);
        const dst = normalizeAbsolutePath(targetPath);

        if (window.MJSI && typeof window.MJSI.invoke === "function") {
            if (mode === "move" && src === dst) {
                issues.push("Source and target are the same.");
                return { moved: 0, issues };
            }

            const sources = items
                .map((it) => it && it.name ? `${src}/${it.name}` : "")
                .filter(Boolean);

            const action = mode === "move" ? "fs.move" : "fs.copy";
            const payload = {
                sources,
                destDir: dst,
                conflictPolicy: "keep-both"
            };

            let res = await window.MJSI.invoke(action, payload);
            if (res && res.ok !== true && res.canElevate && appConfirm("Permission denied. Retry as admin?")) {
                res = await window.MJSI.invoke(action, { ...payload, elevate: true });
            }

            if (!res || res.ok !== true) {
                const err = res && Array.isArray(res.errors) && res.errors[0]
                    ? `${res.errors[0].code || ""} ${res.errors[0].message || ""}`.trim()
                    : (res && res.error ? `${res.error.code || ""} ${res.error.message || ""}`.trim() : "Unknown error");
                issues.push(`${mode} failed: ${err}`);
                return { moved: 0, issues };
            }

            const conflicts = Array.isArray(res.conflicts) ? res.conflicts : [];
            conflicts.slice(0, 8).forEach((c) => {
                if (!c) return;
                issues.push(`Conflict: ${(c.from || "") + " -> " + (c.to || "")}`.trim());
            });

            const moved = Array.isArray(res.applied) ? res.applied.length : 0;

            await requestDirectoryListing(src, { reset: true, await: true });
            if (dst !== src) {
                await requestDirectoryListing(dst, { reset: true, await: true });
            }

            return { moved, issues };
        }

        // Fallback to mock mutation (web-only mode)
        ensureDir(dst);
        const targetDir = fileSystem[dst];
        const sourceDir = fileSystem[src] || [];
        if (mode === "move" && src === dst) {
            issues.push("Source and target are the same.");
            return { moved: 0, issues };
        }

        let moved = 0;
        const movedNames = new Set();

        items.forEach((item) => {
            if (!item || !item.name) return;
            const sourceItemPath = `${src}/${item.name}`;
            if (item.type === "folder" && dst.startsWith(`${sourceItemPath}/`)) {
                issues.push(`Skipped '${item.name}': cannot move/copy folder into itself.`);
                return;
            }
            const finalName = getUniqueName(dst, item.name);
            const sourceFolderPath = `${src}/${item.name}`;
            const targetFolderPath = `${dst}/${finalName}`;
            targetDir.push({ ...item, name: finalName, modified: "2026-04-15", git: "modified" });
            if (item.type === "folder" && fileSystem[sourceFolderPath]) {
                if (mode === "move") {
                    moveFolderSubtree(sourceFolderPath, targetFolderPath);
                } else {
                    cloneFolderSubtree(sourceFolderPath, targetFolderPath);
                }
            }
            if (mode === "move") movedNames.add(item.name);
            moved += 1;
        });

        if (mode === "move") {
            fileSystem[src] = sourceDir.filter((entry) => !movedNames.has(entry.name));
        }

        return { moved, issues };
    }

    function schedulePopupFade() {
        if (state.popupFadeTimer) window.clearTimeout(state.popupFadeTimer);
        if (state.popupHideTimer) window.clearTimeout(state.popupHideTimer);
        if (!els.operationPopup) return;
        els.operationPopup.classList.remove("fading");
        state.popupFadeTimer = window.setTimeout(() => {
            if (!els.operationPopup) return;
            els.operationPopup.classList.add("fading");
            state.popupHideTimer = window.setTimeout(() => {
                if (els.operationPopup) {
                    els.operationPopup.classList.add("hidden");
                    els.operationPopup.classList.remove("fading");
                }
            }, 3600);
        }, 2200);
    }

    function applySidebarIconRules() {
        document.querySelectorAll(".nav-item").forEach((parent) => {
            const key = parent.dataset.path || parent.dataset.viewLink || parent.textContent?.trim();
            const icon = state.sidebarIconRules[key];
            if (!icon) return;
            const current = parent.querySelector("svg, img");
            if (!current) return;
            if (String(icon).startsWith("custom:") && state.customIcons[icon]) {
                const img = document.createElement("img");
                img.className = "custom-icon nav-custom-icon";
                img.src = state.customIcons[icon];
                img.alt = "";
                current.replaceWith(img);
            } else {
                let svg = current.tagName === "SVG" ? current : null;
                if (!svg) {
                    svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
                    current.replaceWith(svg);
                }
                svg.innerHTML = `<use href="#${icon}"></use>`;
            }
        });
    }

    function renderHistoryTimeline() {
        if (!els.historyList) return;
        if (!state.ioTimeline.length) {
            els.historyList.innerHTML = '<div class="history-item"><span>No IO history yet.</span><span class="muted">Run file operations to populate timeline.</span></div>';
            if (els.historyDiff) {
                els.historyDiff.textContent = "Select a timeline state to view summary diff.";
            }
            return;
        }
        els.historyList.innerHTML = state.ioTimeline.map((entry, idx) => {
            const active = idx === state.ioTimelineIndex ? "active" : "";
            return `<button class="history-item ${active}" data-history-index="${idx}"><span>${entry.label}</span><span class="muted">${entry.time}</span></button>`;
        }).join("");
        els.historyList.querySelectorAll("[data-history-index]").forEach((btn) => {
            btn.addEventListener("click", () => {
                const idx = Number(btn.getAttribute("data-history-index"));
                const entry = state.ioTimeline[idx];
                if (!entry) return;
                restoreFileSystem(entry.snapshot);
                state.ioTimelineIndex = idx;
                refreshAll();
                renderHistoryTimeline();
                renderHistoryDiff(idx);
                showOperationPopup("Timeline State Loaded", entry.label);
            });
        });
        renderHistoryDiff(state.ioTimelineIndex);
    }

    function flattenSnapshot(snapshot) {
        const map = new Map();
        Object.entries(snapshot || {}).forEach(([dir, entries]) => {
            const list = Array.isArray(entries)
                ? entries
                : (entries && typeof entries === "object" ? Object.values(entries) : []);
            list.forEach((entry) => {
                if (!entry || typeof entry !== "object" || !entry.name) return;
                const key = `${dir}/${entry.name}`;
                map.set(key, `${entry.type}|${entry.modified}|${entry.size}|${entry.git}`);
            });
        });
        return map;
    }

    function renderHistoryDiff(index) {
        if (!els.historyDiff) return;
        const current = state.ioTimeline[index];
        if (!current) {
            els.historyDiff.textContent = "Select a timeline state to view summary diff.";
            return;
        }
        const prev = state.ioTimeline[index - 1];
        if (!prev) {
            els.historyDiff.textContent = "Initial snapshot: no previous state to diff against.";
            return;
        }
        const a = flattenSnapshot(prev.snapshot);
        const b = flattenSnapshot(current.snapshot);
        const added = [];
        const removed = [];
        const changed = [];
        b.forEach((sig, key) => {
            if (!a.has(key)) added.push(key);
            else if (a.get(key) !== sig) changed.push(key);
        });
        a.forEach((_sig, key) => {
            if (!b.has(key)) removed.push(key);
        });
        const lines = [
            `Diff: ${prev.label} -> ${current.label}`,
            "",
            `Added (${added.length})`,
            ...added.slice(0, 12).map((x) => `+ ${x}`),
            "",
            `Removed (${removed.length})`,
            ...removed.slice(0, 12).map((x) => `- ${x}`),
            "",
            `Changed (${changed.length})`,
            ...changed.slice(0, 12).map((x) => `~ ${x}`)
        ];
        if (added.length > 12 || removed.length > 12 || changed.length > 12) {
            lines.push("", "(truncated)");
        }
        els.historyDiff.textContent = lines.join("\n");
    }

    function addTimelineEntry(label, snapshot) {
        if (!state.ioHistoryEnabled) return;
        const time = new Date().toLocaleTimeString();
        const clipped = state.ioTimeline.slice(0, state.ioTimelineIndex + 1);
        clipped.push({ label, snapshot: JSON.parse(JSON.stringify(snapshot)), time });
        state.ioTimeline = clipped.slice(-Math.max(10, Number(state.ioTimelineLimit) || 140));
        state.ioTimelineIndex = state.ioTimeline.length - 1;
        renderHistoryTimeline();
    }

    function appendTerminalLine(text) {
        state.terminalLines.push(text);
        if (state.terminalLines.length > 240) {
            state.terminalLines = state.terminalLines.slice(-240);
        }
        if (els.terminalOutput) {
            els.terminalOutput.textContent = state.terminalLines.join("\n");
            els.terminalOutput.scrollTop = els.terminalOutput.scrollHeight;
        }
    }

    function renderTerminal() {
        if (!els.terminalOutput) return;
        els.terminalOutput.textContent = state.terminalLines.join("\n");
        els.terminalOutput.scrollTop = els.terminalOutput.scrollHeight;
    }

    function toggleTerminal(force) {
        const next = typeof force === "boolean" ? force : !state.terminalVisible;
        state.terminalVisible = next;
        const mainPane = document.querySelector(".main-pane");
        if (els.terminalPane) {
            els.terminalPane.classList.toggle("hidden", !next);
        }
        if (mainPane) {
            mainPane.classList.toggle("terminal-hidden", !next);
        }
        if (els.terminalLauncherBtn) {
            els.terminalLauncherBtn.classList.toggle("open", next);
        }
        if (next && els.terminalInput) {
            renderTerminal();
            els.terminalInput.focus();
        }
    }

    function setTerminalHeight(height) {
        const px = Math.max(120, Math.min(420, Number(height) || 190));
        document.documentElement.style.setProperty("--terminal-height", `${px}px`);
        localStorage.setItem("mmm-terminal-height", String(px));
    }

    function bindTerminalResizer() {
        if (!els.terminalResizer) return;
        let startY = 0;
        let startHeight = 190;
        const onMove = (e) => {
            const delta = startY - e.clientY;
            setTerminalHeight(startHeight + delta);
        };
        const onUp = () => {
            els.terminalResizer.classList.remove("dragging");
            window.removeEventListener("mousemove", onMove);
            window.removeEventListener("mouseup", onUp);
        };
        els.terminalResizer.addEventListener("mousedown", (e) => {
            e.preventDefault();
            startY = e.clientY;
            startHeight = Number(localStorage.getItem("mmm-terminal-height") || "190");
            els.terminalResizer.classList.add("dragging");
            window.addEventListener("mousemove", onMove);
            window.addEventListener("mouseup", onUp);
        });
    }

    function terminalCompletions(prefix) {
        const commands = ["help", "pwd", "ls", "cd", "clear", "echo", "mkdir", "touch", "history"];
        const items = (fileSystem[pathToString()] || []).map((item) => item.name);
        const pool = [...new Set([...commands, ...items])];
        const p = (prefix || "").toLowerCase();
        return pool.filter((entry) => entry.toLowerCase().startsWith(p));
    }

    async function runTerminalCommand(rawInput) {
        const raw = (rawInput || "").trim();
        if (!raw) return;
        if (state.terminalBusy) {
            appendTerminalLine("(terminal busy)");
            return;
        }

        state.terminalBusy = true;
        try {
            appendTerminalLine(`$ ${raw}`);
            state.terminalHistory.push(raw);
            state.terminalHistoryIndex = state.terminalHistory.length;

            const [cmd, ...args] = raw.split(/\s+/);
            const currentPath = pathToString();
            const hasNativeInvoke = Boolean(window.MJSI && typeof window.MJSI.invoke === "function");

            if (cmd === "help") {
                appendTerminalLine("commands: help, cd <path|..>, clear, history (native mode supports running shell commands)");
                return;
            }

            if (cmd === "clear") {
                state.terminalLines = [];
                renderTerminal();
                return;
            }

            if (cmd === "history") {
                const lines = state.ioTimeline.map((it, idx) => `${idx}: ${it.label} (${it.time})`);
                appendTerminalLine(lines.join("\n") || "(no io history)");
                return;
            }

            if (cmd === "cd" && !/[;&|]/.test(raw)) {
                const target = args.join(" ");
                let next = "/Home";
                if (!target || target === "~") {
                    next = "/Home";
                } else if (target === "..") {
                    const parts = currentPath.split("/").filter(Boolean);
                    if (parts.length > 1) parts.pop();
                    next = `/${parts.join("/")}`;
                } else {
                    next = normalizeAbsolutePath(target.startsWith("/") ? target : `${currentPath}/${target}`);
                }

                if (hasNativeInvoke) {
                    const chk = await window.MJSI.invoke("fs.listDir", { path: next, limit: 1 });
                    if (!chk || chk.ok !== true) {
                        const err = chk && chk.error
                            ? `${chk.error.code || ""} ${chk.error.message || ""}`.trim()
                            : "Unable to open directory";
                        appendTerminalLine(`cd: ${err}`);
                        return;
                    }
                }

                openPath(next);
                appendTerminalLine(`changed directory to ${normalizeAbsolutePath(next)}`);
                return;
            }

            if (hasNativeInvoke) {
                const res = await window.MJSI.invoke("term.exec", {
                    cwd: currentPath,
                    command: raw,
                    timeoutMs: 20000,
                    maxOutputKb: 512
                });

                if (!res || res.ok !== true) {
                    const err = res && res.error ? `${res.error.code || ""} ${res.error.message || ""}`.trim() : "Unknown error";
                    appendTerminalLine(`error: ${err}`);
                    return;
                }

                const stdout = String(res.stdout || "");
                const stderr = String(res.stderr || "");
                if (stdout.trim()) appendTerminalLine(stdout.trimEnd());
                if (stderr.trim()) appendTerminalLine(stderr.trimEnd());

                if (res.timedOut) {
                    appendTerminalLine("(timed out)");
                } else if (Number.isInteger(res.exitCode) && res.exitCode !== 0) {
                    appendTerminalLine(`(exit ${res.exitCode})`);
                }

                return;
            }

            // Web-only fallback
            if (cmd === "pwd") {
                appendTerminalLine(currentPath);
            } else if (cmd === "ls") {
                const dir = fileSystem[currentPath] || [];
                appendTerminalLine(dir.map((item) => `${item.type === "folder" ? "d" : "-"} ${item.name}`).join("\n") || "(empty)");
            } else if (cmd === "mkdir") {
                const name = args.join(" ");
                if (!name) {
                    appendTerminalLine("mkdir: missing folder name");
                } else {
                    createFolderHere(name);
                }
            } else if (cmd === "touch") {
                const name = args.join(" ");
                if (!name) {
                    appendTerminalLine("touch: missing file name");
                } else {
                    createFileHere(name);
                }
            } else if (cmd === "echo") {
                appendTerminalLine(args.join(" "));
            } else {
                appendTerminalLine(`command not found: ${cmd}`);
            }
        } finally {
            state.terminalBusy = false;
        }
    }

    function cloneFileSystem() {
        return JSON.parse(JSON.stringify(fileSystem));
    }

    function restoreFileSystem(snapshot) {
        Object.keys(fileSystem).forEach((k) => delete fileSystem[k]);
        Object.entries(snapshot || {}).forEach(([k, v]) => {
            fileSystem[k] = v;
        });
    }

    function showOperationPopup(title, body = "") {
        if (!els.operationPopup) return;
        if (els.operationPopupTitle) els.operationPopupTitle.textContent = title;
        if (els.operationPopupBody) els.operationPopupBody.textContent = body;
        els.operationPopup.classList.remove("hidden");
        schedulePopupFade();
    }

    function ensureActionDialog() {
        let overlay = document.getElementById("actionDialogOverlay");
        if (overlay) return overlay;
        overlay = document.createElement("div");
        overlay.id = "actionDialogOverlay";
        overlay.className = "action-dialog-overlay hidden";
        overlay.innerHTML = [
            '<div class="action-dialog">',
            '<div class="action-dialog-title" id="actionDialogTitle">Action</div>',
            '<div class="action-dialog-message" id="actionDialogMessage"></div>',
            '<input id="actionDialogInput" class="action-dialog-input" />',
            '<div class="action-dialog-actions">',
            '<button class="icon-btn" id="actionDialogCancel">Cancel</button>',
            '<button class="icon-btn" id="actionDialogConfirm">OK</button>',
            '</div>',
            '</div>'
        ].join("");
        document.body.appendChild(overlay);
        return overlay;
    }

    function closeActionDialog() {
        const overlay = document.getElementById("actionDialogOverlay");
        if (!overlay) return;
        overlay.classList.add("hidden");
        overlay.dataset.mode = "";
        overlay.dataset.onConfirm = "";
    }

    function showActionDialog(options = {}) {
        const overlay = ensureActionDialog();
        const titleEl = document.getElementById("actionDialogTitle");
        const messageEl = document.getElementById("actionDialogMessage");
        const inputEl = document.getElementById("actionDialogInput");
        const cancelBtn = document.getElementById("actionDialogCancel");
        const confirmBtn = document.getElementById("actionDialogConfirm");
        if (!titleEl || !messageEl || !inputEl || !cancelBtn || !confirmBtn) return;

        titleEl.textContent = options.title || "Action";
        messageEl.textContent = options.message || "";
        confirmBtn.textContent = options.confirmLabel || "OK";
        cancelBtn.textContent = options.cancelLabel || "Cancel";

        const useInput = options.mode !== "confirm";
        inputEl.classList.toggle("hidden", !useInput);
        if (useInput) {
            inputEl.value = options.defaultValue || "";
            inputEl.placeholder = options.placeholder || "";
        }

        const onCancel = () => {
            closeActionDialog();
        };
        const onConfirm = () => {
            const value = useInput ? String(inputEl.value || "").trim() : "";
            if (useInput && options.requireInput && !value) {
                inputEl.focus();
                return;
            }
            closeActionDialog();
            if (typeof options.onConfirm === "function") {
                options.onConfirm(value);
            }
        };

        cancelBtn.onclick = onCancel;
        confirmBtn.onclick = onConfirm;
        inputEl.onkeydown = (e) => {
            if (e.key === "Enter") onConfirm();
            if (e.key === "Escape") onCancel();
        };
        overlay.onclick = (e) => {
            if (e.target === overlay) onCancel();
        };

        overlay.classList.remove("hidden");
        if (useInput) {
            inputEl.focus();
            inputEl.select();
        } else {
            confirmBtn.focus();
        }
    }

    function ensureTransferDialog() {
        let dialog = document.getElementById("transferDialog");
        if (dialog) return dialog;
        dialog = document.createElement("div");
        dialog.id = "transferDialog";
        dialog.className = "transfer-dialog hidden";
        dialog.innerHTML = [
            '<div class="transfer-card">',
            '<div class="transfer-title" id="transferTitle">Transferring...</div>',
            '<div class="transfer-subtitle" id="transferSubtitle">Preparing operation</div>',
            '<div class="transfer-file" id="transferFile">Current file: --</div>',
            '<div class="transfer-bar"><div class="transfer-bar-fill" id="transferBarFill"></div></div>',
            '<div class="transfer-meta">',
            '<span id="transferPercent">0%</span>',
            '<span id="transferSpeed">0 MB/s</span>',
            '<span id="transferEta">ETA: --</span>',
            '</div>',
            '<div class="transfer-graph"><canvas id="transferGraphCanvas"></canvas></div>',
            '</div>'
        ].join("");
        document.body.appendChild(dialog);
        return dialog;
    }

    function startTransferDialog(operation) {
        const dialog = ensureTransferDialog();
        const title = document.getElementById("transferTitle");
        const subtitle = document.getElementById("transferSubtitle");
        const fileLabel = document.getElementById("transferFile");
        const fill = document.getElementById("transferBarFill");
        const pct = document.getElementById("transferPercent");
        const speed = document.getElementById("transferSpeed");
        const eta = document.getElementById("transferEta");
        const graphCanvas = document.getElementById("transferGraphCanvas");
        if (!title || !subtitle || !fileLabel || !fill || !pct || !speed || !eta || !graphCanvas) return null;

        const label = operation?.label || "File Operation";
        const names = Array.isArray(operation?.meta?.files) && operation.meta.files.length
            ? operation.meta.files.map((name) => String(name || "item"))
            : [label];
        const files = names.map((name) => {
            const hash = Array.from(name).reduce((acc, ch) => ((acc * 31) + ch.charCodeAt(0)) % 9973, 97);
            const sizeMb = 8 + (hash % 420);
            return { name, sizeMb };
        });
        const totalMb = Math.max(1, files.reduce((sum, f) => sum + f.sizeMb, 0));
        const cumulative = [];
        files.reduce((sum, f) => {
            const next = sum + f.sizeMb;
            cumulative.push(next);
            return next;
        }, 0);

        const formatEta = (seconds) => {
            if (!Number.isFinite(seconds) || seconds < 0) return "ETA: --";
            const s = Math.max(0, Math.round(seconds));
            const m = Math.floor(s / 60);
            const rem = s % 60;
            if (m <= 0) return `ETA: ${rem}s`;
            return `ETA: ${m}m ${rem}s`;
        };

        const drawThroughput = (history) => {
            const ctx = graphCanvas.getContext("2d");
            if (!ctx) return;
            const dpr = window.devicePixelRatio || 1;
            const rect = graphCanvas.getBoundingClientRect();
            const w = Math.max(120, Math.floor(rect.width));
            const h = Math.max(40, Math.floor(rect.height));
            if (graphCanvas.width !== Math.floor(w * dpr) || graphCanvas.height !== Math.floor(h * dpr)) {
                graphCanvas.width = Math.floor(w * dpr);
                graphCanvas.height = Math.floor(h * dpr);
            }
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
            ctx.clearRect(0, 0, w, h);

            const maxVal = Math.max(1, ...history);
            ctx.strokeStyle = "rgba(120, 160, 255, 0.28)";
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(0, h - 0.5);
            ctx.lineTo(w, h - 0.5);
            ctx.moveTo(0, h * 0.5);
            ctx.lineTo(w, h * 0.5);
            ctx.stroke();

            if (history.length < 2) return;
            ctx.strokeStyle = "rgba(134, 182, 255, 0.95)";
            ctx.lineWidth = 2;
            ctx.beginPath();
            history.forEach((v, i) => {
                const x = (i / (history.length - 1)) * w;
                const y = h - ((v / maxVal) * (h - 6)) - 3;
                if (i === 0) ctx.moveTo(x, y);
                else ctx.lineTo(x, y);
            });
            ctx.stroke();
        };

        title.textContent = "File Operation";
        subtitle.textContent = label;
        fileLabel.textContent = `Current file: ${files[0]?.name || "--"}`;
        fill.style.width = "0%";
        pct.textContent = "0%";
        speed.textContent = "0 MB/s";
        eta.textContent = "ETA: --";
        dialog.classList.remove("hidden");

        let progress = 0;
        let lastMs = performance.now();
        let lastTransferred = 0;
        let smoothedSpeed = 0;
        const startMs = performance.now();
        const minVisibleMs = 900;
        const targetDurationMs = Math.min(8000, Math.max(1800, files.length * 420 + totalMb * 4.5));
        let completionRequested = false;
        let completionLabel = "Completed";
        const throughputHistory = [];

        const timer = window.setInterval(() => {
            const now = performance.now();
            const elapsedMs = now - startMs;
            const dtMs = Math.max(16, now - lastMs);
            lastMs = now;

            const targetProgress = Math.min(0.965, elapsedMs / targetDurationMs);
            progress = Math.max(progress, targetProgress * (0.92 + Math.random() * 0.08));
            if (completionRequested) {
                progress = Math.min(1, progress + 0.08);
            }

            const transferredMb = totalMb * progress;
            const instantSpeed = ((transferredMb - lastTransferred) / (dtMs / 1000));
            lastTransferred = transferredMb;
            smoothedSpeed = smoothedSpeed ? ((smoothedSpeed * 0.75) + (instantSpeed * 0.25)) : instantSpeed;

            throughputHistory.push(Math.max(0, smoothedSpeed));
            if (throughputHistory.length > 90) throughputHistory.shift();
            drawThroughput(throughputHistory);

            const pointer = cumulative.findIndex((v) => transferredMb <= v);
            const fileIdx = pointer === -1 ? files.length - 1 : pointer;
            const currentName = files[fileIdx]?.name || files[files.length - 1]?.name || "--";

            fill.style.width = `${progress * 100}%`;
            pct.textContent = `${Math.round(progress * 100)}%`;
            speed.textContent = `${Math.max(0, smoothedSpeed).toFixed(1)} MB/s`;
            eta.textContent = formatEta((totalMb - transferredMb) / Math.max(1, smoothedSpeed));
            fileLabel.textContent = `Current file: ${currentName}`;

            if (completionRequested && progress >= 1) {
                subtitle.textContent = completionLabel;
                speed.textContent = "0 MB/s";
                eta.textContent = "ETA: 0s";
                window.clearInterval(timer);
                window.setTimeout(() => {
                    dialog.classList.add("hidden");
                }, 360);
            }
        }, 90);

        return {
            finish(doneLabel = "Completed") {
                completionLabel = doneLabel;
                const elapsedMs = performance.now() - startMs;
                const wait = Math.max(0, minVisibleMs - elapsedMs);
                window.setTimeout(() => {
                    completionRequested = true;
                }, wait);
            }
        };
    }

    function appAlert(message) {
        const host = window.mmmHost;
        if (host && typeof host.alert === "function") {
            host.alert(String(message || ""));
            return;
        }
        window.alert(String(message || ""));
    }

    function appConfirm(message) {
        const host = window.mmmHost;
        if (host && typeof host.confirm === "function") {
            try {
                return Boolean(host.confirm(String(message || "")));
            } catch (_err) {
                return false;
            }
        }
        return window.confirm(String(message || ""));
    }

    function appPrompt(message, defaultValue = "") {
        const host = window.mmmHost;
        if (host && typeof host.prompt === "function") {
            try {
                const value = host.prompt(String(message || ""), String(defaultValue || ""));
                if (value === null || value === undefined) return null;
                return String(value);
            } catch (_err) {
                return null;
            }
        }
        return window.prompt(String(message || ""), String(defaultValue || ""));
    }

    function openExternalTarget(target) {
        const host = window.mmmHost;
        if (host && typeof host.openExternal === "function") {
            host.openExternal(target);
            return;
        }
        window.open(target, "_blank");
    }

    async function requestDirectoryListing(path, options = {}) {
        const normalized = normalizeAbsolutePath(path || pathToString());
        const reset = options.reset !== false;
        const append = options.append === true;
        const awaitResult = options.await === true;

        const work = (async () => {
            if (!window.MJSI || typeof window.MJSI.invoke !== "function") return false;
            if (normalized === "/Home/Recycle Bin" || normalized === "/Home/Network Bin") return false;

            const cursor = append ? (state.dirNextCursor[normalized] || "") : "";
            const showHidden = localStorage.getItem("mmm-show-hidden") === "1";

            state.dirLoading = true;
            try {
                const res = await window.MJSI.invoke("fs.listDir", {
                    path: normalized,
                    cursor: cursor || "",
                    limit: 600,
                    showHidden
                });

                if (!res || res.ok !== true || !Array.isArray(res.entries)) {
                    let code = "EIO";
                    let message = "Failed to list directory";

                    if (res && typeof res === "object") {
                        if (typeof res.error === "string") {
                            message = res.error;
                        } else if (res.error && typeof res.error === "object") {
                            code = String(res.error.code || code);
                            message = String(res.error.message || message);
                        } else if (Array.isArray(res.errors) && res.errors[0] && typeof res.errors[0] === "object") {
                            code = String(res.errors[0].code || code);
                            message = String(res.errors[0].message || message);
                        }
                    } else if (typeof res === "string" && res.trim()) {
                        message = res;
                    }

                    state.dirLastError = { code, message };
                    if (reset) fileSystem[normalized] = [];
                    state.dirNextCursor[normalized] = "";
                    showOperationPopup("Folder Error", `${normalized}\n${code} ${message}`.trim());
                    return false;
                }

                if (reset || !append) {
                    fileSystem[normalized] = res.entries.slice();
                } else {
                    ensureDir(normalized);
                    fileSystem[normalized].push(...res.entries);
                }

                state.dirNextCursor[normalized] = typeof res.nextCursor === "string" ? res.nextCursor : "";
                state.dirLastError = null;

                if (Number(res.skippedErrors) > 0) {
                    showOperationPopup("Folder Warning", `Some items could not be read (${res.skippedErrors}).`);
                }

                if (normalizeAbsolutePath(pathToString()) === normalized) {
                    refreshAll();
                }

                return true;
            } catch (err) {
                state.dirLastError = { code: "EIO", message: String(err || "invoke failed") };
                state.dirNextCursor[normalized] = "";
                if (reset) fileSystem[normalized] = [];
                showOperationPopup("Folder Error", `${normalized}\n${state.dirLastError.message}`);
                return false;
            } finally {
                state.dirLoading = false;
            }
        })();

        if (awaitResult) return work;
        void work;
        return true;
    }

    async function hydrateFileSystemFromNative() {
        if (!window.MJSI || typeof window.MJSI.invoke !== "function") return;
        try {
            Object.keys(fileSystem).forEach((k) => delete fileSystem[k]);
            fileSystem["/Home/Recycle Bin"] = fileSystem["/Home/Recycle Bin"] || [];
            fileSystem["/Home/Network Bin"] = fileSystem["/Home/Network Bin"] || [];
        } catch (_err) {
        }
        await requestDirectoryListing(pathToString(), { reset: true, await: true });
    }

    function bindNativeBridgeEvents() {
        if (!window.MJSI || typeof window.MJSI.on !== "function") return;
        window.MJSI.on("fs.changed", () => {
            requestDirectoryListing(pathToString(), { reset: true });
        });

        window.MJSI.on("config.changed", () => {
            refreshAll();
        });
    }

    async function refreshSystemInfo() {
        if (!els.sysInfoOutput) return;

        if (!window.MJSI || typeof window.MJSI.invoke !== "function") {
            els.sysInfoOutput.value = "(native host not connected)";
            if (els.sysVirtualRoot) els.sysVirtualRoot.value = "/Home";
            return;
        }

        try {
            const res = await window.MJSI.invoke("sys.info", {});
            els.sysInfoOutput.value = res ? JSON.stringify(res, null, 2) : "(no response)";

            const fsRoot = res && typeof res === "object" ? res.fsRoot : null;
            if (els.sysVirtualRoot && fsRoot && typeof fsRoot.virtualRoot === "string") {
                els.sysVirtualRoot.value = fsRoot.virtualRoot;
            }
            if (els.sysRealRoot && fsRoot) {
                const stored = typeof fsRoot.realRootStored === "string" ? fsRoot.realRootStored : "";
                const display = typeof fsRoot.realRootDisplay === "string" ? fsRoot.realRootDisplay : "";
                const abs = typeof fsRoot.realRoot === "string" ? fsRoot.realRoot : "";
                els.sysRealRoot.value = stored || display || abs;
            }
        } catch (err) {
            els.sysInfoOutput.value = String(err && err.message ? err.message : err);
        }
    }

    function recordHistory(beforeSnapshot, label) {
        if (!state.ioHistoryEnabled) {
            showOperationPopup("Operation Complete", `${label}\nIO history is disabled in settings.`);
            return;
        }
        const afterSnapshot = cloneFileSystem();
        if (JSON.stringify(beforeSnapshot) === JSON.stringify(afterSnapshot)) return;
        state.ioHistory.undoStack.push({ before: beforeSnapshot, after: afterSnapshot, label });
        if (state.ioHistory.undoStack.length > Math.max(10, Number(state.ioHistoryLimit) || 140)) {
            state.ioHistory.undoStack.shift();
        }
        state.ioHistory.redoStack = [];
        addTimelineEntry(label, afterSnapshot);
        showOperationPopup("Operation Complete", label);
    }

    function pruneRecycleBin() {
        ensureDir("/Home/Recycle Bin");
        const maxDays = Math.max(1, Number(state.recycleRetentionDays) || 30);
        const maxItems = Math.max(10, Number(state.recycleMaxItems) || 1000);
        const now = Date.now();
        const cutoffMs = maxDays * 24 * 60 * 60 * 1000;
        let entries = (fileSystem["/Home/Recycle Bin"] || []).filter((item) => {
            const stamp = Date.parse(item.deletedAt || "");
            if (Number.isNaN(stamp)) return true;
            return now - stamp <= cutoffMs;
        });
        entries = entries.sort((a, b) => Date.parse(b.deletedAt || "") - Date.parse(a.deletedAt || ""));
        if (entries.length > maxItems) {
            entries = entries.slice(0, maxItems);
        }
        fileSystem["/Home/Recycle Bin"] = entries;
    }

    function updateQueueControlsUI() {
        if (els.queuePauseBtn) {
            els.queuePauseBtn.textContent = state.operationQueuePaused ? "Resume Queue" : "Pause Queue";
        }
    }

    async function processOperationQueue() {
        if (state.operationQueueBusy || state.operationQueuePaused) return;
        const next = state.operationQueue.shift();
        if (!next) {
            updateQueueControlsUI();
            return;
        }
        state.operationQueueBusy = true;
        updateQueueControlsUI();
        const transferUi = startTransferDialog(next);
        const before = cloneFileSystem();
        try {
            await Promise.resolve(next.fn());
            pruneRecycleBin();
            recordHistory(before, next.label);
            if (window.MJSI && typeof window.MJSI.applyFileOperation === "function") {
                await window.MJSI.applyFileOperation({
                    label: next.label,
                    meta: next.meta || {},
                    snapshot: cloneFileSystem(),
                    sourcePath: pathToString()
                });
            }
            refreshAll();
            if (transferUi) transferUi.finish("Completed");
        } catch (err) {
            showOperationPopup("Operation Failed", err && err.message ? err.message : "Unknown error.");
            if (transferUi) transferUi.finish("Failed");
        }
        state.operationQueueBusy = false;
        if (state.operationQueue.length) {
            window.requestAnimationFrame(() => {
                void processOperationQueue();
            });
        }
    }

    function runMutatingOperation(label, fn, meta = {}) {
        const selectedNames = Array.from(state.selection)
            .map((i) => state.items[i]?.name)
            .filter(Boolean);
        const queueMeta = {
            ...meta,
            files: Array.isArray(meta.files) && meta.files.length ? meta.files : selectedNames
        };
        state.operationQueue.push({ label, fn, meta: queueMeta });
        processOperationQueue();
    }

    function undoLastOperation() {
        const entry = state.ioHistory.undoStack.pop();
        if (!entry) {
            showOperationPopup("Undo", "Nothing to undo.");
            return;
        }
        restoreFileSystem(entry.before);
        state.ioHistory.redoStack.push(entry);
        state.ioTimelineIndex = Math.max(0, state.ioTimelineIndex - 1);
        refreshAll();
        renderHistoryTimeline();
        showOperationPopup("Undo", entry.label);
    }

    function redoLastOperation() {
        const entry = state.ioHistory.redoStack.pop();
        if (!entry) {
            showOperationPopup("Redo", "Nothing to redo.");
            return;
        }
        restoreFileSystem(entry.after);
        state.ioHistory.undoStack.push(entry);
        state.ioTimelineIndex = Math.min(state.ioTimeline.length - 1, state.ioTimelineIndex + 1);
        refreshAll();
        renderHistoryTimeline();
        showOperationPopup("Redo", entry.label);
    }

    function mergedContextAction(action) {
        const defaults = baseContextActionDefaults[action] || { label: action, icon: "icon-file", enabled: true };
        return { ...defaults, ...(state.contextActionConfig[action] || {}) };
    }

    function iconMarkup(iconId, extraClass = "") {
        const cls = extraClass ? ` ${extraClass}` : "";
        if (String(iconId || "").startsWith("custom:") && state.customIcons[iconId]) {
            return `<img class="menu-icon custom-icon${cls}" src="${state.customIcons[iconId]}" alt="" />`;
        }
        return `<svg class="menu-icon${cls}"><use href="#${iconId || "icon-file"}"></use></svg>`;
    }

    function normalizeCustomIconKey(raw) {
        const clean = String(raw || "")
            .trim()
            .toLowerCase()
            .replace(/\s+/g, "-")
            .replace(/[^a-z0-9_-]/g, "");
        return clean;
    }

    function persistCustomIcons() {
        localStorage.setItem("mmm-custom-icons", JSON.stringify(state.customIcons));
    }

    function renderImportedIcons() {
        if (!els.importedIconsList) return;
        els.importedIconsList.innerHTML = "";
        const keys = Object.keys(state.customIcons).filter((k) => k.startsWith("custom:")).sort();
        if (!keys.length) {
            els.importedIconsList.innerHTML = '<div class="muted">No imported icons yet.</div>';
            return;
        }
        keys.forEach((key) => {
            const row = document.createElement("div");
            row.className = "imported-icon-row";
            const meta = document.createElement("div");
            meta.className = "imported-icon-meta";
            const img = document.createElement("img");
            img.src = state.customIcons[key];
            img.alt = "";
            const name = document.createElement("span");
            name.className = "imported-icon-name";
            name.textContent = key;
            meta.appendChild(img);
            meta.appendChild(name);
            const removeBtn = document.createElement("button");
            removeBtn.className = "icon-btn slim";
            removeBtn.textContent = "Remove";
            removeBtn.addEventListener("click", () => {
                delete state.customIcons[key];
                persistCustomIcons();
                renderImportedIcons();
                refreshAll();
                showOperationPopup("Icon Removed", `${key} removed.`);
            });
            row.appendChild(meta);
            row.appendChild(removeBtn);
            els.importedIconsList.appendChild(row);
        });
    }

    function saveImportedIcon(keyRaw, dataUrl) {
        const key = normalizeCustomIconKey(keyRaw);
        if (!key) {
            showOperationPopup("Icon Import", "Enter a valid icon key first.");
            return;
        }
        const iconId = `custom:${key}`;
        state.customIcons[iconId] = dataUrl;
        persistCustomIcons();
        renderImportedIcons();
        refreshAll();
        showOperationPopup("Icon Imported", `Saved as ${iconId}. Use this id in icon rules.`);
    }

    function svgMarkupToDataUrl(markup) {
        return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(markup)}`;
    }

    function applyContextMenuPresentation() {
        if (!els.contextMenu) return;
        els.contextMenu.classList.toggle("expanded", state.contextExpanded);
        els.contextMenu.querySelectorAll("li[data-action]").forEach((li) => {
            if (li.dataset.custom === "1") return;
            const action = li.dataset.action || "";
            const cfg = mergedContextAction(action);
            li.innerHTML = `${iconMarkup(cfg.icon || "icon-file")}<span>${cfg.label || action}</span>`;
        });
    }

    function buildCustomContextItems() {
        if (!els.contextMenu) return;
        els.contextMenu.querySelectorAll("li[data-custom='1']").forEach((node) => node.remove());
        const separator = els.contextMenu.querySelector(".menu-separator");
        state.customContextActions.forEach((entry) => {
            if (!entry || !entry.id || !entry.label) return;
            const li = document.createElement("li");
            li.dataset.action = `custom:${entry.id}`;
            li.dataset.custom = "1";
            li.innerHTML = `${iconMarkup(entry.icon || "icon-file")}<span>${entry.label}</span>`;
            li.addEventListener("click", () => {
                onContextAction(li.dataset.action || "");
                closeContextMenu();
            });
            if (separator) {
                els.contextMenu.insertBefore(li, separator);
            } else {
                els.contextMenu.appendChild(li);
            }
        });
    }

    function ensureDir(path) {
        if (!fileSystem[path]) {
            fileSystem[path] = [];
        }
    }

    function setCurrentPathFromString(path) {
        state.currentPath = normalizePath(path);
        ensureDir(pathToString());
    }

    function normalizeShortcut(raw) {
        return raw
            .trim()
            .replace(/\s+/g, "")
            .replace(/cmd/gi, "Ctrl")
            .replace(/control/gi, "Ctrl")
            .replace(/(^.|\+.)/g, (m) => m.toUpperCase());
    }

    function eventMatchesShortcut(e, shortcut) {
        const normalized = normalizeShortcut(shortcut || "");
        const parts = normalized.split("+").filter(Boolean);
        const key = parts[parts.length - 1]?.toLowerCase() || "";
        if (!key) return false;
        const needCtrl = parts.includes("Ctrl");
        const needShift = parts.includes("Shift");
        const needAlt = parts.includes("Alt");
        const ctrlPressed = e.ctrlKey || e.metaKey;
        if (needCtrl !== ctrlPressed) return false;
        if (needShift !== e.shiftKey) return false;
        if (needAlt !== e.altKey) return false;
        return e.key.toLowerCase() === key;
    }

    function persistShortcuts() {
        localStorage.setItem("mmm-shortcut-spotlight", state.shortcuts.spotlight);
        localStorage.setItem("mmm-shortcut-newtab", state.shortcuts.newTab);
        localStorage.setItem("mmm-shortcut-newfolder", state.shortcuts.newFolder);
        localStorage.setItem("mmm-shortcut-newfile", state.shortcuts.newFile);
        localStorage.setItem("mmm-shortcut-refresh", state.shortcuts.refresh);
        localStorage.setItem("mmm-shortcut-preview", state.shortcuts.togglePreview);
        localStorage.setItem("mmm-shortcut-back", state.shortcuts.back);
        localStorage.setItem("mmm-shortcut-forward", state.shortcuts.forward);
        localStorage.setItem("mmm-shortcut-copy", state.shortcuts.copy);
        localStorage.setItem("mmm-shortcut-cut", state.shortcuts.cut);
        localStorage.setItem("mmm-shortcut-paste", state.shortcuts.paste);
        localStorage.setItem("mmm-shortcut-undo", state.shortcuts.undo);
        localStorage.setItem("mmm-shortcut-redo", state.shortcuts.redo);
        localStorage.setItem("mmm-shortcut-rename", state.shortcuts.rename);
        localStorage.setItem("mmm-shortcut-delete", state.shortcuts.del);
        localStorage.setItem("mmm-shortcut-selectall", state.shortcuts.selectAll);
        localStorage.setItem("mmm-shortcut-duplicate", state.shortcuts.duplicate);
        localStorage.setItem("mmm-shortcut-history", state.shortcuts.toggleHistory);
        localStorage.setItem("mmm-shortcut-terminal", state.shortcuts.toggleTerminal);
    }

    function inferExt(name) {
        const parts = name.split(".");
        if (parts.length < 2) return "txt";
        return (parts.pop() || "txt").toLowerCase();
    }

    function getUniqueName(targetPath, originalName) {
        const dir = fileSystem[targetPath] || [];
        const used = new Set(dir.map((it) => it.name.toLowerCase()));
        if (!used.has(originalName.toLowerCase())) return originalName;
        const dot = originalName.lastIndexOf(".");
        const hasExt = dot > 0;
        const base = hasExt ? originalName.slice(0, dot) : originalName;
        const ext = hasExt ? originalName.slice(dot) : "";
        let i = 2;
        let candidate = `${base} (${i})${ext}`;
        while (used.has(candidate.toLowerCase())) {
            i += 1;
            candidate = `${base} (${i})${ext}`;
        }
        return candidate;
    }

    function cloneFolderSubtree(sourceRoot, targetRoot) {
        const updates = [];
        Object.keys(fileSystem).forEach((key) => {
            if (!key.startsWith(`${sourceRoot}/`)) return;
            const suffix = key.slice(sourceRoot.length);
            const nextKey = `${targetRoot}${suffix}`;
            updates.push([nextKey, fileSystem[key].map((entry) => ({ ...entry }))]);
        });
        updates.forEach(([k, v]) => {
            fileSystem[k] = v;
        });
    }

    function moveFolderSubtree(sourceRoot, targetRoot) {
        cloneFolderSubtree(sourceRoot, targetRoot);
        Object.keys(fileSystem).forEach((key) => {
            if (key.startsWith(`${sourceRoot}/`)) {
                delete fileSystem[key];
            }
        });
    }

    function openPropertiesWindow(item, absolutePath) {
        if (!item) return;
        const payload = encodeURIComponent(JSON.stringify({ ...item, path: absolutePath }));
        const url = `item-properties.html?item=${payload}`;
        window.open(url, "mmm-properties", "width=560,height=620,resizable=yes,scrollbars=yes");
    }

    function applyTheme(theme) {
        state.theme = theme;
        document.documentElement.setAttribute("data-theme", theme);
        localStorage.setItem("mmm-theme", theme);
        const themeSelect = document.getElementById("themeSelect");
        if (themeSelect) {
            themeSelect.value = theme;
        }
    }

    function loadCurrentDirectory() {
        const dir = fileSystem[pathToString()] || [];
        state.items = dir.map((item) => ({ ...item }));
    }

    function persistNavHistory() {
        localStorage.setItem("mmm-nav-history", JSON.stringify(state.navHistory));
        localStorage.setItem("mmm-nav-history-index", String(state.navHistoryIndex));
    }

    function rememberPath(path) {
        const normalized = normalizeAbsolutePath(path);
        if (state.navHistory[state.navHistoryIndex] === normalized) return;
        state.navHistory = state.navHistory.slice(0, state.navHistoryIndex + 1);
        state.navHistory.push(normalized);
        if (state.navHistory.length > 240) {
            state.navHistory = state.navHistory.slice(-240);
        }
        state.navHistoryIndex = state.navHistory.length - 1;
        persistNavHistory();
    }

    function navigateHistory(delta) {
        const nextIndex = state.navHistoryIndex + delta;
        if (nextIndex < 0 || nextIndex >= state.navHistory.length) return;
        state.navHistoryIndex = nextIndex;
        persistNavHistory();
        openPath(state.navHistory[state.navHistoryIndex], { remember: false });
    }

    function openPath(path, options = {}) {
        const remember = options.remember !== false;
        setCurrentPathFromString(path);
        try {
            localStorage.setItem("mmm-last-path", pathToString());
        } catch (_err) {
        }
        if (remember) {
            rememberPath(pathToString());
        }
        requestDirectoryListing(pathToString(), { reset: true });
        refreshAll();
    }

    function addTab(path) {
        const resolved = path || pathToString();
        if (!state.tabs.includes(resolved)) {
            state.tabs.push(resolved);
        }
        state.activeTab = state.tabs.indexOf(resolved);
        openPath(resolved);
    }

    function insertTabAt(path, index) {
        const resolved = path || pathToString();
        const existing = state.tabs.indexOf(resolved);
        if (existing !== -1) {
            state.activeTab = existing;
            openPath(resolved);
            return;
        }
        const safeIndex = Math.max(0, Math.min(index, state.tabs.length));
        state.tabs.splice(safeIndex, 0, resolved);
        state.activeTab = safeIndex;
        openPath(resolved);
    }

    function closeTab(index) {
        if (state.tabs.length <= 1) return;
        state.tabs.splice(index, 1);
        if (state.activeTab >= state.tabs.length) {
            state.activeTab = state.tabs.length - 1;
        }
        openPath(state.tabs[state.activeTab]);
    }

    function closeTabByPath(path) {
        const idx = state.tabs.indexOf(path);
        if (idx === -1) return;
        closeTab(idx);
    }

    function emitCrossWindowCommand(command) {
        try {
            localStorage.setItem("mmm-window-command", JSON.stringify({
                ...command,
                sourceWindowId: state.windowId,
                commandId: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
            }));
        } catch (_err) {
            // Ignore localStorage sync errors and continue local behavior.
        }
    }

    function bindCrossWindowCommands() {
        window.addEventListener("storage", (e) => {
            if (e.key !== "mmm-window-command" || !e.newValue) return;
            let payload = null;
            try {
                payload = JSON.parse(e.newValue);
            } catch (_err) {
                return;
            }
            if (!payload || payload.targetWindowId !== state.windowId) return;
            if (payload.action === "close-tab-by-path" && typeof payload.path === "string") {
                nativeLog("info", "window.command.closeTabByPath", { from: payload.sourceWindowId || "", path: payload.path });
                closeTabByPath(normalizeAbsolutePath(payload.path));
            }
        });
    }

    function openInNewWindow(path, options = {}) {
        const normalized = normalizeAbsolutePath(path || pathToString());
        const sessionToken = options && typeof options.sessionToken === "string" ? options.sessionToken : "";
        const url = `index.html?path=${encodeURIComponent(normalized)}${sessionToken ? `&session=${encodeURIComponent(sessionToken)}` : ""}`;

        const host = window.mmmHost;
        nativeLog("info", "window.openInNewWindow", { path: normalized, hasSessionToken: Boolean(sessionToken), hasNativeHost: Boolean(host && typeof host.invoke === "function") });

        if (host && typeof host.invoke === "function") {
            host.invoke("app.newWindow", { path: normalized, sessionToken })
                .then((res) => {
                    nativeLog("info", "window.openInNewWindow.result", { path: normalized, ok: Boolean(res && res.ok === true) });
                    if (!res || res.ok !== true) {
                        window.open(url, "_blank");
                    }
                })
                .catch((err) => {
                    nativeLog("error", "window.openInNewWindow.error", { path: normalized, error: String(err || "invoke failed") });
                    window.open(url, "_blank");
                });
            return;
        }
        window.open(url, "_blank");
    }

    const SESSION_KEY = "mmm-session-v1";
    const SESSION_RESTORE_LOCK_KEY = "mmm-session-restore-lock";
    const PENDING_WINDOW_SESSION_PREFIX = "mmm-pending-window-session:";

    let sessionSaveTimer = null;

    function saveWindowSession() {
        try {
            const now = Date.now();
            const raw = localStorage.getItem(SESSION_KEY);
            const session = raw ? JSON.parse(raw) : { version: 1, windows: {}, updatedAt: 0 };
            if (!session || typeof session !== "object") return;
            if (!session.windows || typeof session.windows !== "object") session.windows = {};

            const tabs = state.tabs.filter((t) => typeof t === "string" && t.length < 2048).slice(0, 40);
            const activeTab = Math.max(0, Math.min(Number(state.activeTab) || 0, Math.max(0, tabs.length - 1)));

            session.windows[state.windowId] = {
                tabs,
                activeTab,
                lastSeen: now
            };
            session.updatedAt = now;
            localStorage.setItem(SESSION_KEY, JSON.stringify(session));
        } catch (_err) {
            // Ignore localStorage quota / serialization failures.
        }
    }

    function scheduleWindowSessionSave() {
        if (sessionSaveTimer) {
            clearTimeout(sessionSaveTimer);
        }
        sessionSaveTimer = setTimeout(() => {
            sessionSaveTimer = null;
            saveWindowSession();
        }, 250);
    }

    function savePendingWindowSession(token, windowData) {
        if (!token) return;
        nativeLog("info", "session.pending.save", {
            token,
            tabs: windowData && Array.isArray(windowData.tabs) ? windowData.tabs.length : 0,
            activeTab: windowData && typeof windowData.activeTab === "number" ? windowData.activeTab : null
        });
        try {
            localStorage.setItem(`${PENDING_WINDOW_SESSION_PREFIX}${token}`, JSON.stringify(windowData));
        } catch (_err) {
        }
    }

    function consumePendingWindowSession(token) {
        if (!token) return false;
        nativeLog("info", "session.consume.start", { token });

        let raw = "";
        try {
            raw = localStorage.getItem(`${PENDING_WINDOW_SESSION_PREFIX}${token}`) || "";
        } catch (err) {
            nativeLog("error", "session.consume.readError", { token, error: String(err || "read failed") });
            return false;
        }
        if (!raw) {
            nativeLog("warn", "session.consume.missing", { token });
            return false;
        }
        try {
            const payload = JSON.parse(raw);
            if (!payload || !Array.isArray(payload.tabs) || !payload.tabs.length) {
                nativeLog("warn", "session.consume.invalid", { token, hasTabs: Boolean(payload && payload.tabs), tabsLen: payload && Array.isArray(payload.tabs) ? payload.tabs.length : 0 });
                return false;
            }
            const nextTabs = dedupeTabs(payload.tabs.map((p) => normalizeAbsolutePath(String(p))));
            const safeActive = Math.max(0, Math.min(Number(payload.activeTab) || 0, nextTabs.length - 1));

            state.tabs.splice(0, state.tabs.length, ...nextTabs);
            state.activeTab = safeActive;
            setCurrentPathFromString(state.tabs[state.activeTab]);
            scheduleWindowSessionSave();

            try {
                const active = state.tabs[state.activeTab] || "/Home";
                window.history.replaceState({}, "", `index.html?path=${encodeURIComponent(active)}`);
            } catch (_err3) {
            }

            nativeLog("info", "session.consume.applied", { token, tabs: nextTabs.length, activeTab: safeActive });

            try {
                localStorage.removeItem(`${PENDING_WINDOW_SESSION_PREFIX}${token}`);
            } catch (_err2) {
            }
            return true;
        } catch (err) {
            nativeLog("error", "session.consume.parseError", { token, error: String(err || "parse failed") });
            return false;
        }
    }

    function acquireSessionRestoreLock() {
        const now = Date.now();
        try {
            const lockRaw = localStorage.getItem(SESSION_RESTORE_LOCK_KEY) || "";
            if (lockRaw) {
                const lock = JSON.parse(lockRaw);
                if (lock && typeof lock.at === "number" && now - lock.at < 8000) {
                    nativeLog("warn", "session.restore.locked", { by: lock.by || "", ageMs: now - lock.at });
                    return false;
                }
            }
        } catch (_err) {
        }

        try {
            localStorage.setItem(SESSION_RESTORE_LOCK_KEY, JSON.stringify({ at: now, by: state.windowId }));
        } catch (_err) {
        }
        return true;
    }

    function restoreWindowsFromLastSession() {
        if (!acquireSessionRestoreLock()) return false;

        nativeLog("info", "session.restore.start", { href: window.location.href });

        const session = parseLocalJSON(SESSION_KEY, null);
        if (!session || typeof session !== "object" || !session.windows || typeof session.windows !== "object") {
            nativeLog("warn", "session.restore.noSession", { hasSession: Boolean(session) });
            return false;
        }

        const updatedAt = Number(session.updatedAt) || 0;
        const cutoff = updatedAt > 0 ? updatedAt - 7 * 24 * 60 * 60 * 1000 : Date.now() - 7 * 24 * 60 * 60 * 1000;
        const windows = Object.values(session.windows)
            .filter((w) => w && Array.isArray(w.tabs) && w.tabs.length)
            .map((w) => ({
                tabs: w.tabs.map((p) => normalizeAbsolutePath(String(p))),
                activeTab: Math.max(0, Math.min(Number(w.activeTab) || 0, w.tabs.length - 1)),
                lastSeen: Number(w.lastSeen) || 0
            }))
            .filter((w) => w.lastSeen >= cutoff);

        if (!windows.length) {
            nativeLog("warn", "session.restore.noWindows", { cutoff });
            return false;
        }
        windows.sort((a, b) => b.lastSeen - a.lastSeen);

        const primary = windows[0];
        const primaryTabs = dedupeTabs(primary.tabs);
        state.tabs.splice(0, state.tabs.length, ...primaryTabs);
        state.activeTab = Math.max(0, Math.min(primary.activeTab, primaryTabs.length - 1));
        setCurrentPathFromString(state.tabs[state.activeTab]);

        try {
            const active = state.tabs[state.activeTab] || "/Home";
            window.history.replaceState({}, "", `index.html?path=${encodeURIComponent(active)}`);
        } catch (_err) {
        }

        nativeLog("info", "session.restore.applied", {
            primaryTabs: primaryTabs.length,
            primaryActiveTab: state.activeTab,
            extraWindowsDetected: Math.max(0, windows.length - 1)
        });

        if (windows.length > 1) {
            nativeLog("info", "session.restore.skipExtraWindows", {
                skipped: windows.length - 1,
                reason: "startup-primary-only"
            });
        }

        scheduleWindowSessionSave();
        return true;
    }

    function renderTabs() {
        if (!els.tabStrip) return;
        els.tabStrip.innerHTML = "";
        if (tabDragUI.indicator && tabDragUI.indicator.parentElement !== els.tabStrip) {
            els.tabStrip.appendChild(tabDragUI.indicator);
        }
        state.tabs.forEach((tabPath, idx) => {
            const tab = document.createElement("div");
            tab.className = `tab ${idx === state.activeTab ? "active" : ""}`;
            tab.draggable = true;
            tab.dataset.tabIndex = String(idx);
            tab.innerHTML = `<button class="tab-open" data-tab-open="${idx}"><svg><use href="#icon-folder"></use></svg><span>${tabPath.split("/").pop() || "Home"}</span></button><button class="tab-close" data-tab-close="${idx}" title="Close Tab"><svg><use href="#icon-close"></use></svg></button>`;
            els.tabStrip.appendChild(tab);

            tab.addEventListener("dragstart", (e) => {
                state.draggedTabIndex = idx;
                nativeLog("info", "tab.dragstart", { path: tabPath, tabIndex: idx, activeTab: state.activeTab, tabs: state.tabs.length });
                writeCrossWindowTabDrag(tabPath);

                ensureTabDragUI();
                tabDragUI.active = true;
                tabDragUI.dropped = false;
                tabDragUI.detachTriggered = false;
                tabDragUI.path = tabPath;
                tabDragUI.sourceWindowId = state.windowId;
                tabDragUI.dropIndex = idx;

                if (tabDragUI.ghost) {
                    const label = tabPath.split("/").pop() || "Home";
                    tabDragUI.ghost.textContent = label;
                    tabDragUI.ghost.classList.remove("hidden");
                    tabDragUI.ghost.style.left = `${Math.max(0, e.clientX + 12)}px`;
                    tabDragUI.ghost.style.top = `${Math.max(0, e.clientY + 12)}px`;
                }

                if (tabDragUI.detachHint) tabDragUI.detachHint.classList.remove("visible");
                if (tabDragUI.indicator) tabDragUI.indicator.classList.remove("visible");

                if (e.dataTransfer) {
                    e.dataTransfer.effectAllowed = "move";
                    e.dataTransfer.setData("text/mmm-tab", JSON.stringify({
                        sourceWindowId: state.windowId,
                        path: tabPath
                    }));
                    e.dataTransfer.setData("text/plain", tabPath);
                }
            });
            tab.addEventListener("dragover", (e) => {
                const hasExternalTab = Boolean(resolveTabDragPayload(e));
                if (state.draggedTabIndex === null && !hasExternalTab) return;
                e.preventDefault();
            });
            tab.addEventListener("drop", (e) => {
                const payload = resolveTabDragPayload(e);
                if (!payload) return;
                e.preventDefault();

                if (tabDragUI.indicator) tabDragUI.indicator.classList.remove("visible");
                if (tabDragUI.detachHint) tabDragUI.detachHint.classList.remove("visible");
                tabDragUI.dropped = true;

                const incomingPath = normalizeAbsolutePath(payload.path);
                nativeLog("info", "tab.drop.onTab", {
                    incomingPath,
                    targetIndex: idx,
                    sourceWindowId: payload.sourceWindowId || "",
                    sameWindow: payload.sourceWindowId === state.windowId
                });

                if (payload.sourceWindowId === state.windowId) {
                    const from = state.tabs.indexOf(incomingPath);
                    const to = idx;
                    if (from !== -1) {
                        let insertTo = to;
                        if (from < to) insertTo = Math.max(0, to - 1);
                        if (from !== insertTo) {
                            const moved = state.tabs.splice(from, 1)[0];
                            state.tabs.splice(insertTo, 0, moved);
                            state.activeTab = state.tabs.indexOf(moved);
                            renderTabs();
                        }
                        state.draggedTabIndex = null;
                        return;
                    }
                }

                insertTabAt(incomingPath, idx);
                if (payload.sourceWindowId && payload.sourceWindowId !== state.windowId) {
                    emitCrossWindowCommand({
                        action: "close-tab-by-path",
                        targetWindowId: payload.sourceWindowId,
                        path: incomingPath
                    });
                }
                state.draggedTabIndex = null;
            });
            tab.addEventListener("dragend", (e) => {
                const dropEffect = e && e.dataTransfer ? e.dataTransfer.dropEffect : "none";
                const droppedSomewhere = tabDragUI.active && tabDragUI.dropped;

                let detach = false;
                if (!droppedSomewhere && tabDragUI.active) {
                    const outOfWindow = e.clientX <= 0 || e.clientX >= window.innerWidth || e.clientY <= 0 || e.clientY >= window.innerHeight;
                    if (outOfWindow) {
                        detach = true;
                    } else {
                        detach = isPointerOutsideTabStrip(e.clientX, e.clientY);
                    }
                }

                nativeLog("info", "tab.dragend", {
                    path: tabPath,
                    droppedSomewhere,
                    uiDropped: tabDragUI.dropped,
                    dropEffect,
                    detach,
                    x: e.clientX,
                    y: e.clientY,
                    windowW: window.innerWidth,
                    windowH: window.innerHeight
                });

                if (detach && !tabDragUI.detachTriggered) {
                    tabDragUI.detachTriggered = true;
                    openInNewWindow(tabPath);
                    if (state.tabs.length > 1) {
                        closeTabByPath(tabPath);
                    }
                }

                state.draggedTabIndex = null;
                hideTabDragUI();
            });
        });

        els.tabStrip.querySelectorAll("[data-tab-open]").forEach((btn) => {
            btn.addEventListener("click", () => {
                const idx = Number(btn.getAttribute("data-tab-open"));
                const nextPath = state.tabs[idx];
                if (!nextPath) return;
                state.activeTab = idx;
                openPath(nextPath);
            });
        });

        els.tabStrip.querySelectorAll("[data-tab-close]").forEach((btn) => {
            btn.addEventListener("click", (e) => {
                e.stopPropagation();
                closeTab(Number(btn.getAttribute("data-tab-close")));
            });
        });
    }

    function renderBreadcrumbs() {
        if (!els.breadcrumbs) return;
        els.breadcrumbs.innerHTML = "";
        state.currentPath.forEach((part, index) => {
            const b = document.createElement("button");
            b.className = "crumb";
            b.type = "button";
            b.textContent = part;
            b.addEventListener("click", () => {
                state.currentPath = state.currentPath.slice(0, index + 1);
                refreshAll();
            });
            els.breadcrumbs.appendChild(b);
            if (index < state.currentPath.length - 1) {
                const sep = document.createElement("span");
                sep.className = "crumb-sep";
                sep.textContent = "/";
                els.breadcrumbs.appendChild(sep);
            }
        });
    }

    function setPathInputMode(on) {
        if (!els.pathInput || !els.breadcrumbs) return;
        if (on) {
            els.pathInput.classList.remove("hidden");
            els.breadcrumbs.classList.add("hidden");
            els.pathInput.value = pathToString();
            els.pathInput.focus();
            els.pathInput.select();
            return;
        }
        els.pathInput.classList.add("hidden");
        els.breadcrumbs.classList.remove("hidden");
    }

    function iconFor(item, fullPath = "") {
        if (item.type === "folder") {
            return state.folderIconRules[fullPath] || "icon-folder";
        }
        if (item.ext && state.fileIconRules[item.ext]) {
            return state.fileIconRules[item.ext];
        }
        if (item.ext === "js" || item.ext === "ts") return "icon-file-code";
        if (item.ext === "png" || item.ext === "jpg") return "icon-file-image";
        return "icon-file";
    }

    function rowTemplate(item, idx) {
        const selected = state.selection.has(idx) ? "selected" : "";
        const fullPath = `${pathToString()}/${item.name}`;
        const cutPending = state.clipboard.mode === "cut" && state.clipboard.sourcePath === pathToString() && state.clipboard.items.some((it) => it.name === item.name) ? "cut-pending" : "";
        return `<div class="file-item ${selected} ${cutPending}" draggable="true" data-index="${idx}" data-type="${item.type}">${iconMarkup(iconFor(item, fullPath), "file-icon")}<div class="file-name">${item.name}</div>${state.viewMode === "details" ? `<div class="meta-row"><span>${item.size}</span><span>${item.modified}</span><span class="git-badge git-${item.git}">${item.git}</span></div>` : ""}</div>`;
    }

    function renderFiles() {
        if (!els.fileRegion) return;
        els.fileRegion.className = `file-region ${state.viewMode}`;

        const cwd = normalizeAbsolutePath(pathToString());
        const cursor = state.dirNextCursor && typeof state.dirNextCursor === "object" ? (state.dirNextCursor[cwd] || "") : "";
        const extraRow = state.dirLoading
            ? `<div class="file-item load-more" data-load-more="0">${iconMarkup("icon-refresh", "file-icon")}<div class="file-name">Loading…</div></div>`
            : (cursor
                ? `<div class="file-item load-more" data-load-more="1">${iconMarkup("icon-refresh", "file-icon")}<div class="file-name">Load more…</div></div>`
                : "");

        els.fileRegion.innerHTML = state.items.map((item, idx) => rowTemplate(item, idx)).join("") + extraRow;
        bindFileInteractions();
        syncSelectionUI();
    }

    function syncSelectionUI() {
        if (!els.fileRegion) return;
        els.fileRegion.querySelectorAll(".file-item").forEach((row) => {
            const idx = Number(row.dataset.index);
            row.classList.toggle("selected", state.selection.has(idx));
        });
    }

    function selectedItems() {
        return Array.from(state.selection).map((i) => state.items[i]).filter(Boolean);
    }

    function renderRecycleBinOperationsPreview() {
        if (!els.previewBody) return;
        const count = state.selection.size;
        els.previewBody.innerHTML = [
            '<div class="muted">Recycle Bin Operations</div>',
            `<div class="muted">Selected: ${count} item(s)</div>`,
            '<div class="dialog-actions">',
            '<button class="icon-btn" id="previewRestoreBtn">Restore Selected</button>',
            '<button class="icon-btn" id="previewDeleteBtn">Delete Selected</button>',
            '<button class="icon-btn" id="previewEmptyBinBtn">Empty Bin</button>',
            '</div>'
        ].join("");

        const restoreBtn = document.getElementById("previewRestoreBtn");
        if (restoreBtn) {
            restoreBtn.addEventListener("click", () => {
                if (!state.selection.size) {
                    showOperationPopup("Recycle Bin", "Select item(s) to restore first.");
                    return;
                }
                onContextAction("restoreItem");
            });
        }

        const deleteBtn = document.getElementById("previewDeleteBtn");
        if (deleteBtn) {
            deleteBtn.addEventListener("click", () => {
                if (!state.selection.size) {
                    showOperationPopup("Recycle Bin", "Select item(s) to delete first.");
                    return;
                }
                onContextAction("delete", { permanent: true });
            });
        }

        const emptyBtn = document.getElementById("previewEmptyBinBtn");
        if (emptyBtn) {
            emptyBtn.addEventListener("click", () => onContextAction("emptyRecycleBin"));
        }
    }

    function renderNetworkBinOperationsPreview() {
        if (!els.previewBody) return;
        const count = state.selection.size;
        els.previewBody.innerHTML = [
            '<div class="muted">Network Bin Operations</div>',
            `<div class="muted">Selected: ${count} item(s)</div>`,
            '<div class="dialog-actions">',
            '<button class="icon-btn" id="previewConnectNetworkBtn">Connect</button>',
            '<button class="icon-btn" id="previewDisconnectNetworkBtn">Disconnect Selected</button>',
            '</div>'
        ].join("");

        const connectBtn = document.getElementById("previewConnectNetworkBtn");
        if (connectBtn) {
            connectBtn.addEventListener("click", () => {
                showActionDialog({
                    title: "Connect Network Target",
                    message: "Enter network endpoint",
                    defaultValue: "\\\\SERVER\\Share",
                    placeholder: "\\\\SERVER\\Share",
                    confirmLabel: "Connect",
                    requireInput: true,
                    onConfirm: (endpoint) => {
                        const target = normalizeAbsolutePath("/Home/Network Bin");
                        runMutatingOperation(`Connected network target: ${endpoint}`, () => {
                            ensureDir(target);
                            const dir = fileSystem[target] || [];
                            const safeName = endpoint.replace(/[\\/:*?"<>|]+/g, "_").replace(/^_+|_+$/g, "") || "Network Target";
                            dir.unshift({
                                name: getUniqueName(target, safeName),
                                type: "folder",
                                size: "--",
                                modified: "2026-04-15",
                                git: "untracked",
                                networkEndpoint: endpoint
                            });
                            fileSystem[target] = dir;
                        });
                    }
                });
            });
        }

        const disconnectBtn = document.getElementById("previewDisconnectNetworkBtn");
        if (disconnectBtn) {
            disconnectBtn.addEventListener("click", () => {
                if (!state.selection.size) {
                    showOperationPopup("Network Bin", "Select connection(s) to disconnect.");
                    return;
                }
                showActionDialog({
                    mode: "confirm",
                    title: "Disconnect Targets",
                    message: "Disconnect selected network target(s)?",
                    confirmLabel: "Disconnect",
                    onConfirm: () => {
                        runMutatingOperation(`Disconnected ${state.selection.size} network target(s)`, () => {
                            const dir = fileSystem[normalizeAbsolutePath("/Home/Network Bin")] || [];
                            const selected = Array.from(state.selection).sort((a, b) => b - a);
                            selected.forEach((idx) => dir.splice(idx, 1));
                            state.selection.clear();
                        });
                    }
                });
            });
        }
    }

    function renderPreview() {
        if (!els.previewBody) return;
        const cwd = normalizeAbsolutePath(pathToString());
        if (isRecycleBinPath(cwd)) {
            renderRecycleBinOperationsPreview();
            return;
        }
        if (cwd === "/Home/Network Bin") {
            renderNetworkBinOperationsPreview();
            return;
        }
        const list = selectedItems();
        if (!list.length) {
            els.previewBody.textContent = "Select a file to preview metadata.";
            return;
        }
        const first = list[0];
        els.previewBody.textContent = [
            `name: ${first.name}`,
            `type: ${first.type}`,
            `size: ${first.size || "--"}`,
            `modified: ${first.modified}`,
            `git: ${first.git}`,
            `path: ${pathToString()}/${first.name}`
        ].join("\n");
    }

    function renderPropertiesPanel() {
        if (!els.propertiesTable) return;
        const active = selectedItems()[0] || state.items[0];
        if (!active) {
            els.propertiesTable.innerHTML = '<div class="properties-row"><span class="muted">No item selected</span><span>--</span></div>';
            return;
        }
        const rows = [
            ["Name", active.name],
            ["Type", active.type],
            ["Modified", active.modified],
            ["Size", active.size || "--"],
            ["Git Status", active.git],
            ["Location", `${pathToString()}/${active.name}`]
        ];
        els.propertiesTable.innerHTML = rows.map(([k, v]) => `<div class="properties-row"><span class="muted">${k}</span><span>${v}</span></div>`).join("");
    }

    function switchViewPanels() {
        const isExplorer = state.activeView === "explorer";
        const isSettings = state.activeView === "settings";
        const isProperties = state.activeView === "properties";
        if (els.explorerPanel) els.explorerPanel.classList.toggle("hidden", !isExplorer);
        if (els.settingsPanel) els.settingsPanel.classList.toggle("hidden", !isSettings);
        if (els.propertiesPanel) els.propertiesPanel.classList.toggle("hidden", !isProperties);
    }

    function updateCwd() {
        if (els.cwdLabel) {
            els.cwdLabel.textContent = `cwd: ${pathToString()}`;
        }
    }

    function togglePreviewPane(force) {
        const next = typeof force === "boolean" ? force : !state.previewVisible;
        state.previewVisible = next;
        if (els.previewPane) {
            els.previewPane.classList.toggle("hidden", !next);
        }
        if (els.workspace) {
            els.workspace.classList.toggle("preview-hidden", !next);
        }
    }

    function setSelection(indices, anchor = null) {
        state.selection = new Set(indices);
        state.anchorIndex = anchor;
        syncSelectionUI();
        renderPreview();
        renderPropertiesPanel();
    }

    function showPropertiesForIndex(index) {
        if (index === null || index === undefined || !state.items[index]) return;
        setSelection([index], index);
        const item = state.items[index];
        openPropertiesWindow(item, `${pathToString()}/${item.name}`);
    }

    function addFavorite(path) {
        if (!els.favorites || !path) return;
        const normalizedPath = normalizeAbsolutePath(path);
        const exists = Array.from(els.favorites.querySelectorAll(".nav-item[data-path]")).some((node) => normalizeAbsolutePath(node.dataset.path || "") === normalizedPath);
        if (exists) return;
        const btn = document.createElement("button");
        btn.className = "nav-item";
        btn.dataset.path = normalizedPath;
        btn.draggable = true;
        const sidebarKey = normalizedPath.split("/").pop() || normalizedPath;
        const icon = state.sidebarIconRules[normalizedPath] || state.sidebarIconRules[sidebarKey] || "icon-folder";
        btn.innerHTML = `${iconMarkup(icon)}<span>${sidebarKey}</span>`;
        btn.addEventListener("click", () => {
            openPath(normalizedPath);
        });
        els.favorites.appendChild(btn);
        bindFavoriteInteractions();
        applySidebarIconRules();
    }

    function bindFavoriteInteractions() {
        if (!els.favorites) return;
        const items = Array.from(els.favorites.querySelectorAll(".nav-item[data-path]"));
        items.forEach((node, idx) => {
            node.draggable = true;
            node.dataset.favoriteIndex = String(idx);
        });

        if (els.favorites.dataset.favoriteDelegatedBound === "1") return;
        els.favorites.dataset.favoriteDelegatedBound = "1";

        const clearFavoriteHoverTargets = () => {
            if (!els.favorites) return;
            els.favorites.classList.remove("drag-target");
            els.favorites.querySelectorAll(".nav-item[data-path]").forEach((n) => n.classList.remove("drag-target"));
        };

        const markAllFavoriteHoverTargets = () => {
            if (!els.favorites) return;
            els.favorites.querySelectorAll(".nav-item[data-path]").forEach((n) => n.classList.add("drag-target"));
        };

        const refreshFavoriteIndices = () => {
            Array.from(els.favorites.querySelectorAll(".nav-item[data-path]")).forEach((node, idx) => {
                node.dataset.favoriteIndex = String(idx);
                node.draggable = true;
            });
        };

        els.favorites.addEventListener("dragstart", (e) => {
            const node = e.target.closest(".nav-item[data-path]");
            if (!node) return;
            if (state.dragKind === "file-items") return;
            state.dragKind = "favorite-item";
            state.draggedFavoriteIndex = Number(node.dataset.favoriteIndex || "-1");
            if (e.dataTransfer) {
                e.dataTransfer.effectAllowed = "move";
                e.dataTransfer.setData("mmm-kind", "favorite-item");
                e.dataTransfer.setData("text/plain", node.dataset.path || "");
            }
        });

        els.favorites.addEventListener("dragover", (e) => {
            const node = e.target.closest(".nav-item[data-path]");
            if (state.dragKind === "file-items") {
                e.preventDefault();
                e.stopPropagation();
                clearFavoriteHoverTargets();
                if (node) {
                    node.classList.add("drag-target");
                } else {
                    markAllFavoriteHoverTargets();
                }
                if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
                return;
            }
            if (state.dragKind === "favorite-item" && node) {
                e.preventDefault();
                if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
            }
        });

        els.favorites.addEventListener("drop", (e) => {
            const node = e.target.closest(".nav-item[data-path]");
            if (!node) return;

            if (state.dragKind === "file-items") {
                e.preventDefault();
                e.stopPropagation();
                clearFavoriteHoverTargets();
                const payload = state.dragPayload || draggedItemsPayload(state.draggedItemIndex);
                if (!payload.items.length) return;
                const targetPath = normalizeAbsolutePath(node.dataset.path || "");
                runMutatingOperation(`Moved ${payload.items.length} item(s) to ${targetPath}`, async () => {
                    const result = await transferItemsFromSource(payload.items, payload.sourcePath, targetPath, "move");
                    if (result.issues.length) {
                        showOperationPopup("Favorites Drop Issues", result.issues.join("\n"));
                    }
                }, { files: payload.items.map((it) => it.name) });
                return;
            }

            if (state.dragKind === "favorite-item") {
                e.preventDefault();
                const from = state.draggedFavoriteIndex;
                const to = Number(node.dataset.favoriteIndex || "-1");
                if (from < 0 || to < 0 || from === to) return;
                const favoritesItems = Array.from(els.favorites.querySelectorAll(".nav-item[data-path]"));
                const moved = favoritesItems[from];
                const target = favoritesItems[to];
                if (!moved || !target) return;
                if (from < to) {
                    target.insertAdjacentElement("afterend", moved);
                } else {
                    target.insertAdjacentElement("beforebegin", moved);
                }
                state.draggedFavoriteIndex = null;
                refreshFavoriteIndices();
            }
        });

        els.favorites.addEventListener("dragleave", (e) => {
            if (e.target === els.favorites) {
                clearFavoriteHoverTargets();
            }
        });

        els.favorites.addEventListener("dragend", () => {
            clearFavoriteHoverTargets();
            if (state.dragKind === "favorite-item") {
                state.dragKind = null;
                state.draggedFavoriteIndex = null;
            }
        });
    }

    function createFolderHere(name) {
        if (!name) return;
        const cleanName = name.trim();
        if (!cleanName) return;

        runMutatingOperation(`Created folder: ${cleanName}`, async () => {
            const key = normalizeAbsolutePath(pathToString());
            if (window.MJSI && typeof window.MJSI.invoke === "function") {
                const payload = {
                    path: key,
                    name: cleanName,
                    conflictPolicy: "keep-both"
                };
                let res = await window.MJSI.invoke("fs.mkdir", payload);
                if (res && res.ok !== true && res.canElevate && appConfirm("Permission denied. Retry as admin?")) {
                    res = await window.MJSI.invoke("fs.mkdir", { ...payload, elevate: true });
                }
                if (!res || res.ok !== true) {
                    const err = res && res.error ? `${res.error.code || ""} ${res.error.message || ""}`.trim() : "Unknown error";
                    throw new Error(`mkdir failed: ${err}`);
                }
                await requestDirectoryListing(key, { reset: true, await: true });
                return;
            }

            // Fallback to mock mutation (web-only mode)
            const finalName = getUniqueName(key, cleanName);
            const next = { name: finalName, type: "folder", size: "--", modified: "2026-04-15", git: "untracked" };
            ensureDir(key);
            fileSystem[key].unshift(next);
        });
    }

    function createFileHere(name) {
        if (!name) return;
        const cleanName = name.trim();
        if (!cleanName) return;

        runMutatingOperation(`Created file: ${cleanName}`, async () => {
            const key = normalizeAbsolutePath(pathToString());
            if (window.MJSI && typeof window.MJSI.invoke === "function") {
                const payload = {
                    path: key,
                    name: cleanName,
                    conflictPolicy: "keep-both"
                };
                let res = await window.MJSI.invoke("fs.createFile", payload);
                if (res && res.ok !== true && res.canElevate && appConfirm("Permission denied. Retry as admin?")) {
                    res = await window.MJSI.invoke("fs.createFile", { ...payload, elevate: true });
                }
                if (!res || res.ok !== true) {
                    const err = res && res.error ? `${res.error.code || ""} ${res.error.message || ""}`.trim() : "Unknown error";
                    throw new Error(`createFile failed: ${err}`);
                }
                await requestDirectoryListing(key, { reset: true, await: true });
                return;
            }

            // Fallback to mock mutation (web-only mode)
            const finalName = getUniqueName(key, cleanName);
            const next = {
                name: finalName,
                type: "file",
                ext: inferExt(finalName),
                size: "1 KB",
                modified: "2026-04-15",
                git: "untracked"
            };
            ensureDir(key);
            fileSystem[key].unshift(next);
        });
    }

    function copyOrCutSelected(mode) {
        const selected = Array.from(state.selection).sort((a, b) => a - b);
        if (!selected.length) {
            showOperationPopup(mode === "cut" ? "Cut Error" : "Copy Error", "Select at least one item first.");
            return;
        }
        state.clipboard.mode = mode;
        state.clipboard.sourcePath = pathToString();
        state.clipboard.items = selected.map((idx) => ({ ...state.items[idx] }));
        renderFiles();
        showOperationPopup(mode === "cut" ? "Cut Ready" : "Copy Ready", `${selected.length} item(s) prepared from ${state.clipboard.sourcePath}`);
    }

    function pasteClipboard(targetPath, forceMode = null) {
        const mode = forceMode || state.clipboard.mode;
        if (!mode || !state.clipboard.items.length) {
            showOperationPopup("Paste Error", "Clipboard is empty.");
            return;
        }
        const normalizedTarget = normalizeAbsolutePath(targetPath);
        runMutatingOperation(`${mode === "cut" ? "Moved" : "Pasted"} ${state.clipboard.items.length} item(s) to ${normalizedTarget}`, async () => {
            const result = await transferItemsFromSource(
                state.clipboard.items,
                state.clipboard.sourcePath,
                normalizedTarget,
                mode === "cut" ? "move" : "copy"
            );
            if (result.issues.length) {
                showOperationPopup("Paste Issues", result.issues.join("\n"));
            }
            if (mode === "cut" && result.moved > 0) {
                state.clipboard = { mode: null, sourcePath: "", items: [] };
            }
        }, { files: state.clipboard.items.map((it) => it.name) });
    }

    function moveSelectedToPath(targetPathInput) {
        const targetPath = normalizeAbsolutePath(targetPathInput || "");
        if (!targetPath) {
            showOperationPopup("Move Error", "Target path is invalid.");
            return;
        }
        copyOrCutSelected("cut");
        pasteClipboard(targetPath, "cut");
    }

    function openDialog(dialog, input, defaultValue) {
        if (!dialog || !input) return;
        input.value = defaultValue;
        dialog.classList.remove("hidden");
        input.focus();
        input.select();
    }

    function closeDialog(dialog) {
        if (!dialog) return;
        dialog.classList.add("hidden");
    }

    function duplicateSelected() {
        const selected = Array.from(state.selection).sort((a, b) => a - b);
        if (!selected.length) return;
        runMutatingOperation(`Duplicated ${selected.length} item(s)`, () => {
            const dir = fileSystem[pathToString()] || [];
            selected.forEach((idx) => {
                const item = dir[idx];
                if (!item) return;
                const copyName = item.type === "folder"
                    ? `${item.name} copy`
                    : item.name.includes(".")
                        ? `${item.name.replace(/(\.[^.]+)$/, "")} copy${item.name.match(/(\.[^.]+)$/)?.[0] || ""}`
                        : `${item.name} copy`;
                dir.push({ ...item, name: copyName, modified: "2026-04-15", git: "untracked" });
            });
        }, { files: selected.map((idx) => state.items[idx]?.name).filter(Boolean) });
    }

    function draggedItemsPayload(fallbackIndex = null) {
        const sourcePath = state.draggedSourcePath || pathToString();
        const sourceDir = fileSystem[sourcePath] || [];
        let indices = Array.isArray(state.draggedIndices) ? state.draggedIndices.slice() : [];
        if (!indices.length && Number.isInteger(fallbackIndex)) {
            indices = [fallbackIndex];
        }
        const unique = Array.from(new Set(indices)).filter((i) => i >= 0 && i < sourceDir.length);
        const items = unique.map((i) => ({ ...sourceDir[i] }));
        return { sourcePath, items, indices: unique };
    }

    function buildDragGhost(count, name) {
        const ghost = document.createElement("div");
        ghost.className = "drag-stack-ghost";
        ghost.textContent = count > 1 ? `${count} items` : name || "item";
        document.body.appendChild(ghost);
        return ghost;
    }

    function openItem(index) {
        const item = state.items[index];
        if (!item) return;
        if (item.type === "folder") {
            const nextPath = normalizeAbsolutePath(`${pathToString()}/${item.name}`);
            state.selection.clear();
            openPath(nextPath);
            return;
        }
        setSelection([index], index);
    }

    function bindFileInteractions() {
        if (!els.fileRegion) return;
        const rows = els.fileRegion.querySelectorAll(".file-item");
        rows.forEach((row) => {
            if (row.dataset.loadMore) {
                row.addEventListener("click", () => {
                    const cwd = normalizeAbsolutePath(pathToString());
                    const cursor = state.dirNextCursor && typeof state.dirNextCursor === "object" ? (state.dirNextCursor[cwd] || "") : "";
                    if (!cursor || state.dirLoading) return;
                    requestDirectoryListing(cwd, { reset: false, append: true });
                });
                return;
            }

            const idx = Number(row.dataset.index);

            row.addEventListener("click", (e) => {
                if (state.isDragging || Date.now() < state.suppressClickUntil) {
                    e.preventDefault();
                    return;
                }
                if (e.shiftKey && state.anchorIndex !== null) {
                    const start = Math.min(state.anchorIndex, idx);
                    const end = Math.max(state.anchorIndex, idx);
                    const group = [];
                    for (let i = start; i <= end; i += 1) group.push(i);
                    setSelection(group, state.anchorIndex);
                    return;
                }
                if (e.ctrlKey || e.metaKey) {
                    const next = new Set(state.selection);
                    if (next.has(idx)) next.delete(idx);
                    else next.add(idx);
                    setSelection(Array.from(next), idx);
                    return;
                }
                setSelection([idx], idx);
            });

            row.addEventListener("dblclick", () => {
                openItem(idx);
            });

            row.addEventListener("contextmenu", (e) => {
                e.preventDefault();
                if (!state.selection.has(idx)) {
                    setSelection([idx], idx);
                }
                openContextMenu(e.clientX, e.clientY, "item");
            });

            row.addEventListener("dragstart", (e) => {
                state.isDragging = true;
                document.body.classList.add("no-text-select");
                state.draggedItemIndex = idx;
                state.draggedFavoriteIndex = null;
                state.dragKind = "file-items";
                state.draggedSourcePath = pathToString();
                state.shiftHeld = Boolean(e.shiftKey);
                const activeSelection = Array.from(state.selection);
                state.draggedIndices = state.selection.has(idx) && activeSelection.length > 1 ? activeSelection : [idx];
                state.dragPayload = draggedItemsPayload(idx);
                row.classList.add("dragging");
                e.dataTransfer.effectAllowed = "copyMove";
                e.dataTransfer.setData("text/plain", String(idx));
                e.dataTransfer.setData("mmm-kind", "file-items");
                const payload = state.dragPayload;
                const ghost = buildDragGhost(payload.items.length, payload.items[0]?.name || "item");
                e.dataTransfer.setDragImage(ghost, 18, 18);
                window.requestAnimationFrame(() => ghost.remove());
            });

            row.addEventListener("dragend", () => {
                state.isDragging = false;
                document.body.classList.remove("no-text-select");
                state.suppressClickUntil = Date.now() + 140;
                row.classList.remove("dragging");
                state.draggedItemIndex = null;
                state.draggedSourcePath = "";
                state.draggedIndices = [];
                state.dragPayload = null;
                if (state.dragKind === "file-items") state.dragKind = null;
                if (els.tabStrip) els.tabStrip.classList.remove("drag-target");
                if (els.topDropArea) els.topDropArea.classList.remove("drag-target");
                if (els.favorites) {
                    els.favorites.classList.remove("drag-target");
                    els.favorites.querySelectorAll(".nav-item[data-path]").forEach((n) => n.classList.remove("drag-target"));
                }
            });

            row.addEventListener("dragover", (e) => {
                if (state.draggedItemIndex === null || state.draggedSourcePath !== pathToString()) return;
                const target = state.items[idx];
                if (!target || target.type !== "folder") return;
                e.preventDefault();
                state.shiftHeld = Boolean(e.shiftKey);
                e.dataTransfer.dropEffect = state.shiftHeld ? "copy" : "move";
                row.classList.add("drag-target");
            });

            row.addEventListener("dragleave", () => {
                row.classList.remove("drag-target");
            });

            row.addEventListener("drop", (e) => {
                if (state.draggedItemIndex === null || state.draggedSourcePath !== pathToString()) return;
                const target = state.items[idx];
                if (!target || target.type !== "folder") return;
                e.preventDefault();
                row.classList.remove("drag-target");
                const payload = draggedItemsPayload(state.draggedItemIndex);
                if (!payload.items.length) return;
                const targetPath = `${pathToString()}/${target.name}`;
                const mode = state.shiftHeld ? "copy" : "move";
                runMutatingOperation(`${mode === "copy" ? "Copied" : "Moved"} ${payload.items.length} item(s) to ${target.name}`, async () => {
                    const result = await transferItemsFromSource(payload.items, payload.sourcePath, targetPath, mode);
                    if (result.issues.length) {
                        showOperationPopup("Drag/Drop Issues", result.issues.join("\n"));
                    }
                }, { files: payload.items.map((it) => it.name) });
            });
        });

        if (!state.fileRegionContextBound) {
            els.fileRegion.addEventListener("contextmenu", (e) => {
                if (e.target.closest(".file-item")) return;
                e.preventDefault();
                setSelection([], null);
                openContextMenu(e.clientX, e.clientY, "background");
            });
            state.fileRegionContextBound = true;
        }
    }

    function openContextMenu(x, y, scope = "item") {
        if (!els.contextMenu) return;
        buildCustomContextItems();
        applyContextMenuPresentation();
        state.menuScope = scope;
        const selected = selectedItems();
        const first = selected[0] || null;
        const isFolder = first?.type === "folder";
        const isSingle = selected.length === 1;
        const isRecycleView = isRecycleBinPath(pathToString());

        els.contextMenu.querySelectorAll("li[data-action]").forEach((li) => {
            const action = li.dataset.action;
            if (action.startsWith("custom:")) {
                const customId = action.replace("custom:", "");
                const custom = state.customContextActions.find((c) => c.id === customId);
                const needsSelection = Boolean(custom?.requiresSelection);
                li.classList.toggle("hidden", needsSelection && !selected.length);
                return;
            }
            let visible = true;
            const cfg = mergedContextAction(action);
            if (cfg.enabled === false) {
                li.classList.add("hidden");
                return;
            }
            if (scope === "background") {
                visible = ["newFolder", "newFile", "refresh", "selectAll", "pasteItem", "undo", "redo", "emptyRecycleBin"].includes(action);
            } else {
                if (["rename", "properties", "openNewTab", "copyPath", "addFavorite", "moveTo", "setFolderIcon", "setSidebarIcon"].includes(action) && !isSingle) visible = false;
                if (action === "addFavorite" && !isFolder) visible = false;
                if (action === "setFolderIcon" && !isFolder) visible = false;
                if (action === "openNewTab" && !isSingle) visible = false;
            }
            if (action === "restoreItem") visible = isRecycleView && selected.length > 0;
            if (action === "emptyRecycleBin") visible = isRecycleView;
            if (action === "pasteItem" && !state.clipboard.items.length) visible = false;
            if (action === "undo" && !state.ioHistory.undoStack.length) visible = false;
            if (action === "redo" && !state.ioHistory.redoStack.length) visible = false;
            if (["open", "rename", "duplicate", "copyItem", "cutItem", "copyPath", "properties", "delete", "moveTo", "openNewTab", "addFavorite", "setFolderIcon", "setSidebarIcon"].includes(action) && !selected.length) {
                visible = false;
            }
            li.classList.toggle("hidden", !visible);
        });

        els.contextMenu.querySelectorAll(".menu-separator").forEach((sep) => {
            const hasTop = Array.from(els.contextMenu.querySelectorAll("li[data-action]")).some((li) => !li.classList.contains("hidden") && !["newFolder", "newFile", "refresh", "selectAll", "pasteItem", "undo", "redo", "emptyRecycleBin"].includes(li.dataset.action || ""));
            const hasBottom = Array.from(els.contextMenu.querySelectorAll("li[data-action]")).some((li) => !li.classList.contains("hidden") && ["newFolder", "newFile", "refresh", "selectAll", "pasteItem", "undo", "redo", "emptyRecycleBin"].includes(li.dataset.action || ""));
            sep.classList.toggle("hidden", !(hasTop && hasBottom));
        });

        els.contextMenu.classList.remove("hidden");
        els.contextMenu.style.left = `${x}px`;
        els.contextMenu.style.top = `${y}px`;
    }

    function closeContextMenu() {
        if (!els.contextMenu) return;
        els.contextMenu.classList.add("hidden");
    }

    function onContextAction(action, options = {}) {
        const selected = Array.from(state.selection).sort((a, b) => b - a);
        const hasSelection = selected.length > 0;
        const isRecycleView = isRecycleBinPath(pathToString());

        if (action.startsWith("custom:")) {
            const id = action.replace("custom:", "");
            const custom = state.customContextActions.find((c) => c.id === id);
            if (!custom) return;
            const firstIdx = selected[0];
            const firstItem = Number.isInteger(firstIdx) ? state.items[firstIdx] : null;
            const selectedPath = firstItem ? `${pathToString()}/${firstItem.name}` : pathToString();
            const command = String(custom.command || "")
                .replace(/\{\{path\}\}/g, selectedPath)
                .replace(/\{\{name\}\}/g, firstItem?.name || "")
                .replace(/\{\{cwd\}\}/g, pathToString());

            if (command.startsWith("open:")) {
                const target = command.slice(5);
                const normalizedTarget = target.startsWith("/") ? `file://${target}` : target;
                openExternalTarget(normalizedTarget);
            } else if (command.startsWith("alert:")) {
                appAlert(command.slice(6));
            } else {
                appAlert(`Unknown custom command format: ${command}`);
            }
            return;
        }

        if (action === "newFolder") {
            openDialog(els.newFolderDialog, els.newFolderNameInput, "new-folder");
            return;
        }
        if (action === "newFile") {
            openDialog(els.newFileDialog, els.newFileNameInput, "untitled.txt");
            return;
        }
        if (action === "selectAll") {
            setSelection(state.items.map((_, i) => i), 0);
            return;
        }
        if (action === "undo") {
            undoLastOperation();
            return;
        }
        if (action === "redo") {
            redoLastOperation();
            return;
        }
        if (action === "refresh") {
            performRefresh();
            return;
        }
        if (action === "emptyRecycleBin") {
            if (!isRecycleView) {
                showOperationPopup("Recycle Bin", "Open Recycle Bin to empty it.");
                return;
            }
            showActionDialog({
                mode: "confirm",
                title: "Empty Recycle Bin",
                message: "Empty Recycle Bin permanently? This may conflict with older IO timeline snapshots.",
                confirmLabel: "Empty",
                onConfirm: () => {
                    runMutatingOperation("Emptied Recycle Bin", () => {
                        fileSystem["/Home/Recycle Bin"] = [];
                    });
                    showOperationPopup("Recycle Bin Emptied", "Recycle Bin was cleared. Old IO snapshots may still reference deleted entries.");
                }
            });
            return;
        }
        if (action === "pasteItem") {
            pasteClipboard(pathToString());
            return;
        }
        if (action === "restoreItem") {
            if (!isRecycleView) {
                showOperationPopup("Restore", "Restore is only available in Recycle Bin.");
                return;
            }
            runMutatingOperation(`Restored ${selected.length} item(s)`, () => {
                const bin = fileSystem["/Home/Recycle Bin"] || [];
                selected.forEach((idx) => {
                    const item = bin[idx];
                    if (!item) return;
                    const targetPath = normalizeAbsolutePath(item.deletedFrom || "/Home");
                    ensureDir(targetPath);
                    const restored = { ...item };
                    delete restored.deletedFrom;
                    delete restored.deletedAt;
                    restored.name = getUniqueName(targetPath, restored.name);
                    fileSystem[targetPath].push(restored);
                });
                selected.forEach((idx) => bin.splice(idx, 1));
            });
            return;
        }

        if (!hasSelection) return;

        if (action === "open") {
            openItem(selected[0]);
        } else if (action === "openNewTab") {
            const idx = selected[0];
            const item = state.items[idx];
            if (!item) return;
            if (item.type === "folder") {
                addTab(`${pathToString()}/${item.name}`);
            } else {
                showPropertiesForIndex(idx);
            }
        } else if (action === "copyItem") {
            copyOrCutSelected("copy");
        } else if (action === "cutItem") {
            copyOrCutSelected("cut");
        } else if (action === "moveTo") {
            showActionDialog({
                title: "Move Selected Items",
                message: "Enter target path",
                defaultValue: pathToString(),
                placeholder: "/Home/workspace",
                confirmLabel: "Move",
                requireInput: true,
                onConfirm: (target) => moveSelectedToPath(target)
            });
        } else if (action === "setFolderIcon") {
            const idx = selected[0];
            const item = state.items[idx];
            if (item?.type !== "folder") return;
            const fullPath = `${pathToString()}/${item.name}`;
            showActionDialog({
                title: "Set Folder Icon",
                message: "Enter icon id from icons.svg",
                defaultValue: state.folderIconRules[fullPath] || "icon-folder",
                confirmLabel: "Apply",
                requireInput: true,
                onConfirm: (nextIcon) => {
                    state.folderIconRules[fullPath] = nextIcon.trim();
                    localStorage.setItem("mmm-folder-icon-rules", JSON.stringify(state.folderIconRules));
                    renderFiles();
                }
            });
        } else if (action === "setSidebarIcon") {
            const idx = selected[0];
            const item = state.items[idx];
            if (!item) return;
            const fullPath = `${pathToString()}/${item.name}`;
            showActionDialog({
                title: "Set Sidebar Icon",
                message: "Enter icon id from icons.svg",
                defaultValue: state.sidebarIconRules[fullPath] || "icon-folder",
                confirmLabel: "Apply",
                requireInput: true,
                onConfirm: (nextIcon) => {
                    state.sidebarIconRules[fullPath] = nextIcon.trim();
                    state.sidebarIconRules[item.name] = nextIcon.trim();
                    localStorage.setItem("mmm-sidebar-icon-rules", JSON.stringify(state.sidebarIconRules));
                    applySidebarIconRules();
                    showOperationPopup("Sidebar Icon Updated", `${item.name} -> ${nextIcon.trim()}`);
                }
            });
        } else if (action === "addFavorite") {
            const idx = selected[0];
            const item = state.items[idx];
            if (item?.type === "folder") {
                addFavorite(`${pathToString()}/${item.name}`);
            }
        } else if (action === "rename") {
            const idx = selected[0];
            showActionDialog({
                title: "Rename",
                message: "Enter new name",
                defaultValue: state.items[idx].name,
                confirmLabel: "Rename",
                requireInput: true,
                onConfirm: (next) => {
                    runMutatingOperation(`Renamed ${state.items[idx].name} to ${next}`, async () => {
                        const cwd = normalizeAbsolutePath(pathToString());
                        const srcVirt = `${cwd}/${state.items[idx].name}`;
                        if (window.MJSI && typeof window.MJSI.invoke === "function") {
                            const payload = {
                                path: srcVirt,
                                newName: String(next || "").trim(),
                                conflictPolicy: "keep-both"
                            };
                            let res = await window.MJSI.invoke("fs.rename", payload);
                            if (res && res.ok !== true && res.canElevate && appConfirm("Permission denied. Retry as admin?")) {
                                res = await window.MJSI.invoke("fs.rename", { ...payload, elevate: true });
                            }
                            if (!res || res.ok !== true) {
                                const err = res && res.error ? `${res.error.code || ""} ${res.error.message || ""}`.trim() : "Unknown error";
                                throw new Error(`rename failed: ${err}`);
                            }
                            await requestDirectoryListing(cwd, { reset: true, await: true });
                            return;
                        }

                        const dir = fileSystem[cwd] || [];
                        dir[idx].name = String(next || "").trim();
                    });
                }
            });
        } else if (action === "duplicate") {
            duplicateSelected();
        } else if (action === "copyPath") {
            const idx = selected[0];
            const fullPath = `${pathToString()}/${state.items[idx].name}`;
            if (navigator.clipboard && navigator.clipboard.writeText) {
                navigator.clipboard.writeText(fullPath);
            }
        } else if (action === "properties") {
            showPropertiesForIndex(selected[0]);
        } else if (action === "delete") {
            const permanent = Boolean(options.permanent) || isRecycleView;
            const prompt = permanent
                ? "Permanently delete selected items? This cannot be undone outside IO history."
                : "Move selected items to Recycle Bin?";
            showActionDialog({
                mode: "confirm",
                title: permanent ? "Delete Permanently" : "Move To Recycle Bin",
                message: prompt,
                confirmLabel: permanent ? "Delete" : "Move",
                onConfirm: () => {
                    runMutatingOperation(`${permanent ? "Permanently deleted" : "Sent to Recycle Bin"} ${selected.length} item(s)`, async () => {
                        const cwd = normalizeAbsolutePath(pathToString());
                        const dir = fileSystem[cwd] || [];

                        if (window.MJSI && typeof window.MJSI.invoke === "function" && permanent) {
                            const paths = selected.map((idx) => `${cwd}/${dir[idx]?.name}`).filter((p) => typeof p === "string" && !p.endsWith("/undefined"));
                            const payload = { paths };
                            let res = await window.MJSI.invoke("fs.delete", payload);
                            if (res && res.ok !== true && res.canElevate && appConfirm("Permission denied. Retry as admin?")) {
                                res = await window.MJSI.invoke("fs.delete", { ...payload, elevate: true });
                            }
                            if (!res || res.ok !== true) {
                                const err = res && Array.isArray(res.errors) && res.errors[0]
                                    ? `${res.errors[0].code || ""} ${res.errors[0].message || ""}`.trim()
                                    : (res && res.error ? `${res.error.code || ""} ${res.error.message || ""}`.trim() : "Unknown error");
                                throw new Error(`delete failed: ${err}`);
                            }
                            await requestDirectoryListing(cwd, { reset: true, await: true });
                            state.selection.clear();
                            return;
                        }

                        if (permanent) {
                            selected.forEach((idx) => dir.splice(idx, 1));
                        } else {
                            ensureDir("/Home/Recycle Bin");
                            const bin = fileSystem["/Home/Recycle Bin"];
                            selected.forEach((idx) => {
                                const item = dir[idx];
                                if (!item) return;
                                bin.push(createRecycleEntry(item, cwd));
                            });
                            selected.forEach((idx) => dir.splice(idx, 1));
                        }
                        state.selection.clear();
                    });
                }
            });
        }
    }

    function bindDropTargets() {
        const handleTopDrop = (idx) => {
            const item = state.items[idx];
            if (!item) return;
            if (item.type === "folder") {
                addTab(`${pathToString()}/${item.name}`);
            } else {
                showPropertiesForIndex(idx);
            }
        };

        if (els.tabStrip) {
            els.tabStrip.addEventListener("dragover", (e) => {
                if (state.draggedItemIndex === null) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = "copy";
                els.tabStrip.classList.add("drag-target");
            });

            els.tabStrip.addEventListener("dragleave", () => {
                els.tabStrip.classList.remove("drag-target");
            });

            els.tabStrip.addEventListener("drop", (e) => {
                if (state.draggedItemIndex === null) return;
                e.preventDefault();
                els.tabStrip.classList.remove("drag-target");
                handleTopDrop(state.draggedItemIndex);
            });

            if (els.tabStrip.dataset.tabDndBound !== "1") {
                els.tabStrip.dataset.tabDndBound = "1";

                els.tabStrip.addEventListener("dragover", (e) => {
                    if (!resolveTabDragPayload(e)) return;
                    e.preventDefault();
                    e.dataTransfer.dropEffect = "move";

                    ensureTabDragUI();
                    const index = computeTabDropIndex(e.clientX);
                    tabDragUI.dropIndex = index;
                    positionTabDropIndicator(index);
                });

                els.tabStrip.addEventListener("dragleave", (e) => {
                    const related = e.relatedTarget;
                    if (related && els.tabStrip.contains(related)) return;
                    if (tabDragUI.indicator) tabDragUI.indicator.classList.remove("visible");
                });

                els.tabStrip.addEventListener("drop", (e) => {
                    const payload = resolveTabDragPayload(e);
                    if (!payload) return;
                    e.preventDefault();

                    ensureTabDragUI();
                    if (tabDragUI.indicator) tabDragUI.indicator.classList.remove("visible");
                    if (tabDragUI.detachHint) tabDragUI.detachHint.classList.remove("visible");
                    tabDragUI.dropped = true;

                    const incomingPath = normalizeAbsolutePath(payload.path);
                    const to = typeof tabDragUI.dropIndex === "number" ? tabDragUI.dropIndex : state.tabs.length;

                    nativeLog("info", "tab.drop.onStrip", {
                        incomingPath,
                        to,
                        sourceWindowId: payload.sourceWindowId || "",
                        sameWindow: payload.sourceWindowId === state.windowId
                    });

                    if (payload.sourceWindowId === state.windowId) {
                        const from = state.tabs.indexOf(incomingPath);
                        if (from !== -1) {
                            let insertTo = Math.max(0, Math.min(to, state.tabs.length));
                            if (insertTo > from) insertTo = Math.max(0, insertTo - 1);
                            if (from !== insertTo) {
                                const moved = state.tabs.splice(from, 1)[0];
                                state.tabs.splice(insertTo, 0, moved);
                                state.activeTab = state.tabs.indexOf(moved);
                                renderTabs();
                            }
                            state.draggedTabIndex = null;
                            return;
                        }
                    }

                    insertTabAt(incomingPath, to);
                    if (payload.sourceWindowId && payload.sourceWindowId !== state.windowId) {
                        emitCrossWindowCommand({
                            action: "close-tab-by-path",
                            targetWindowId: payload.sourceWindowId,
                            path: incomingPath
                        });
                    }
                    state.draggedTabIndex = null;
                });
            }
        }

        if (els.topDropArea) {
            els.topDropArea.addEventListener("dragover", (e) => {
                if (state.draggedItemIndex === null) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = "copy";
                els.topDropArea.classList.add("drag-target");
            });

            els.topDropArea.addEventListener("dragleave", () => {
                els.topDropArea.classList.remove("drag-target");
            });

            els.topDropArea.addEventListener("drop", (e) => {
                if (state.draggedItemIndex === null) return;
                e.preventDefault();
                els.topDropArea.classList.remove("drag-target");
                handleTopDrop(state.draggedItemIndex);
            });
        }

        if (els.favorites) {
            els.favorites.addEventListener("dragover", (e) => {
                if (els.favorites.dataset.favoriteDelegatedBound === "1") return;
                if (state.dragKind !== "file-items") return;
                e.preventDefault();
                state.shiftHeld = Boolean(e.shiftKey);
                e.dataTransfer.dropEffect = "move";
                const hovered = e.target.closest(".nav-item[data-path]");
                if (!hovered) {
                    els.favorites.classList.add("drag-target");
                } else {
                    els.favorites.classList.remove("drag-target");
                }
            });

            els.favorites.addEventListener("dragleave", () => {
                els.favorites.classList.remove("drag-target");
            });

            els.favorites.addEventListener("drop", (e) => {
                if (els.favorites.dataset.favoriteDelegatedBound === "1") return;
                if (state.dragKind !== "file-items") return;
                const onSpecificFavorite = Boolean(e.target.closest(".nav-item[data-path]"));
                if (onSpecificFavorite) return;
                e.preventDefault();
                els.favorites.classList.remove("drag-target");
                els.favorites.querySelectorAll(".nav-item[data-path]").forEach((n) => n.classList.remove("drag-target"));
                const payload = state.dragPayload || draggedItemsPayload(state.draggedItemIndex);
                if (!payload.items.length) return;
                showOperationPopup("Favorites Drop", "Drop onto a specific favorite folder target.");
            });
        }

        if (document.body && document.body.dataset.tabDragDocBound !== "1") {
            document.body.dataset.tabDragDocBound = "1";

            document.addEventListener("dragover", (e) => {
                if (!isTabDragEvent(e)) return;
                ensureTabDragUI();

                if (tabDragUI.active && tabDragUI.ghost) {
                    tabDragUI.ghost.style.left = `${Math.max(0, e.clientX + 12)}px`;
                    tabDragUI.ghost.style.top = `${Math.max(0, e.clientY + 12)}px`;
                }

                if (tabDragUI.active && els.tabStrip && tabDragUI.detachHint) {
                    const rect = els.tabStrip.getBoundingClientRect();
                    const shouldHint = e.clientY > rect.bottom + 28;
                    tabDragUI.detachHint.classList.toggle("visible", shouldHint);
                } else if (tabDragUI.detachHint) {
                    tabDragUI.detachHint.classList.remove("visible");
                }
            });

            document.addEventListener("drop", (e) => {
                if (!isTabDragEvent(e)) return;
                if (tabDragUI.indicator) tabDragUI.indicator.classList.remove("visible");
                if (tabDragUI.detachHint) tabDragUI.detachHint.classList.remove("visible");
            });
        }
    }

    function openSpotlight() {
        if (!els.spotlight || !els.spotlightInput) return;
        els.spotlight.classList.remove("hidden");
        els.spotlightInput.focus();
        runSearch(els.spotlightInput.value.trim());
    }

    function closeSpotlight() {
        if (!els.spotlight) return;
        els.spotlight.classList.add("hidden");
    }

    function matchesSearch(item, query) {
        if (!query) return true;
        const parts = query.split(" ").filter(Boolean);
        let regexMode = false;
        for (const part of parts) {
            if (part === "regex:on") regexMode = true;
        }

        for (const part of parts) {
            if (part.startsWith("type:")) {
                if (item.type !== part.split(":")[1]) return false;
            } else if (part.startsWith("ext:")) {
                if ((item.ext || "") !== part.split(":")[1]) return false;
            } else if (part !== "regex:on") {
                if (regexMode) {
                    try {
                        if (!new RegExp(part, "i").test(item.name)) return false;
                    } catch (_err) {
                        return false;
                    }
                } else if (!item.name.toLowerCase().includes(part.toLowerCase())) {
                    return false;
                }
            }
        }
        return true;
    }

    function runSearch(query) {
        if (!els.spotlightResults) return;
        const matches = state.items.filter((item) => matchesSearch(item, query));
        els.spotlightResults.innerHTML = matches.map((item) => `<div class="search-row">${iconMarkup(iconFor(item, `${pathToString()}/${item.name}`), "file-icon")}<span>${item.name}</span><span class="muted">${item.type}</span></div>`).join("");
    }

    function performRefresh() {
        const region = els.fileRegion;
        if (region) {
            region.animate([{ opacity: 0.55, filter: "blur(1px)" }, { opacity: 1, filter: "blur(0px)" }], { duration: 180, easing: "ease-out" });
        }
        requestDirectoryListing(pathToString(), { reset: true });
        refreshAll();
    }

    function bindMarqueeSelection() {
        if (!els.fileRegion) return;
        let startX = 0;
        let startY = 0;
        let box = null;
        let moved = false;

        els.fileRegion.addEventListener("mousedown", (e) => {
            if (e.button !== 0) return;
            if (state.isDragging || e.target.closest(".file-item")) return;
            e.preventDefault();
            document.body.classList.add("no-text-select");
            startX = e.clientX;
            startY = e.clientY;
            moved = false;
            box = document.createElement("div");
            box.className = "marquee";
            box.style.left = `${startX}px`;
            box.style.top = `${startY}px`;
            box.style.width = "0px";
            box.style.height = "0px";
            document.body.appendChild(box);

            const onMove = (mv) => {
                const left = Math.min(startX, mv.clientX);
                const top = Math.min(startY, mv.clientY);
                const width = Math.abs(mv.clientX - startX);
                const height = Math.abs(mv.clientY - startY);
                moved = moved || width > 4 || height > 4;
                if (!moved) {
                    return;
                }
                box.style.left = `${left}px`;
                box.style.top = `${top}px`;
                box.style.width = `${width}px`;
                box.style.height = `${height}px`;

                const selected = [];
                const rect = box.getBoundingClientRect();
                els.fileRegion.querySelectorAll(".file-item").forEach((node) => {
                    const nr = node.getBoundingClientRect();
                    const intersects = !(rect.right < nr.left || rect.left > nr.right || rect.bottom < nr.top || rect.top > nr.bottom);
                    if (intersects) selected.push(Number(node.dataset.index));
                });
                setSelection(selected, selected[0] ?? null);
            };

            const onUp = () => {
                if (box) box.remove();
                box = null;
                moved = false;
                document.body.classList.remove("no-text-select");
                window.removeEventListener("mousemove", onMove);
                window.removeEventListener("mouseup", onUp);
            };

            window.addEventListener("mousemove", onMove);
            window.addEventListener("mouseup", onUp);
        });
    }

    function handleKeyboard(e) {
        const activeTag = (document.activeElement && document.activeElement.tagName) || "";
        if (activeTag === "INPUT" || activeTag === "SELECT" || activeTag === "TEXTAREA") return;

        if (eventMatchesShortcut(e, state.shortcuts.spotlight)) {
            e.preventDefault();
            if (els.spotlight && !els.spotlight.classList.contains("hidden")) {
                closeSpotlight();
            } else {
                openSpotlight();
            }
            return;
        }
        if (eventMatchesShortcut(e, state.shortcuts.newTab)) {
            e.preventDefault();
            addTab(pathToString());
            return;
        }
        if (eventMatchesShortcut(e, state.shortcuts.newFolder)) {
            e.preventDefault();
            openDialog(els.newFolderDialog, els.newFolderNameInput, "new-folder");
            return;
        }
        if (eventMatchesShortcut(e, state.shortcuts.newFile)) {
            e.preventDefault();
            openDialog(els.newFileDialog, els.newFileNameInput, "untitled.txt");
            return;
        }
        if (eventMatchesShortcut(e, state.shortcuts.refresh)) {
            e.preventDefault();
            performRefresh();
            return;
        }
        if (eventMatchesShortcut(e, state.shortcuts.togglePreview)) {
            e.preventDefault();
            togglePreviewPane();
            return;
        }

        if (eventMatchesShortcut(e, state.shortcuts.back)) {
            e.preventDefault();
            navigateHistory(-1);
            return;
        }

        if (eventMatchesShortcut(e, state.shortcuts.forward)) {
            e.preventDefault();
            navigateHistory(1);
            return;
        }

        if (eventMatchesShortcut(e, state.shortcuts.copy)) {
            e.preventDefault();
            onContextAction("copyItem");
            return;
        }

        if (eventMatchesShortcut(e, state.shortcuts.cut)) {
            e.preventDefault();
            onContextAction("cutItem");
            return;
        }

        if (eventMatchesShortcut(e, state.shortcuts.paste)) {
            e.preventDefault();
            onContextAction("pasteItem");
            return;
        }

        if (eventMatchesShortcut(e, state.shortcuts.undo)) {
            e.preventDefault();
            undoLastOperation();
            return;
        }

        if (eventMatchesShortcut(e, state.shortcuts.redo)) {
            e.preventDefault();
            redoLastOperation();
            return;
        }

        if (eventMatchesShortcut(e, state.shortcuts.rename)) {
            e.preventDefault();
            onContextAction("rename");
            return;
        }

        if (eventMatchesShortcut(e, state.shortcuts.del)) {
            e.preventDefault();
            onContextAction("delete");
            return;
        }

        if (eventMatchesShortcut(e, state.shortcuts.selectAll)) {
            e.preventDefault();
            onContextAction("selectAll");
            return;
        }

        if (eventMatchesShortcut(e, state.shortcuts.duplicate)) {
            e.preventDefault();
            onContextAction("duplicate");
            return;
        }

        if (eventMatchesShortcut(e, state.shortcuts.toggleHistory)) {
            e.preventDefault();
            if (els.historyPanel) {
                els.historyPanel.classList.toggle("hidden");
                renderHistoryTimeline();
            }
            return;
        }

        if (eventMatchesShortcut(e, state.shortcuts.toggleTerminal)) {
            e.preventDefault();
            if (els.terminalLauncherBtn) {
                toggleTerminal();
            }
            return;
        }

        const current = Array.from(state.selection)[0] ?? 0;
        const max = state.items.length - 1;

        if (e.key === "ArrowDown" || e.key === "ArrowRight") {
            e.preventDefault();
            const next = Math.min(current + 1, max);
            setSelection([next], next);
        } else if (e.key === "ArrowUp" || e.key === "ArrowLeft") {
            e.preventDefault();
            const next = Math.max(current - 1, 0);
            setSelection([next], next);
        } else if (e.key === "Enter") {
            e.preventDefault();
            openItem(current);
        } else if (e.key === "Backspace" || (e.altKey && e.key === "ArrowLeft")) {
            e.preventDefault();
            if (e.altKey && e.key === "ArrowLeft") {
                navigateHistory(-1);
            } else if (state.currentPath.length > 1) {
                navigateHistory(-1);
            }
        } else if (e.altKey && e.key === "ArrowRight") {
            e.preventDefault();
            navigateHistory(1);
        } else if (e.key === "F2") {
            e.preventDefault();
            onContextAction("rename");
        } else if (e.shiftKey && e.key === "Delete") {
            e.preventDefault();
            onContextAction("delete", { permanent: true });
        } else if (e.key === "Escape") {
            closeSpotlight();
            closeContextMenu();
            setPathInputMode(false);
            closeDialog(els.newFolderDialog);
            closeDialog(els.newFileDialog);
        }
    }

    function refreshAll() {
        loadCurrentDirectory();
        syncTabsWithCurrentPath();
        renderTabs();
        renderBreadcrumbs();
        updateCwd();
        switchViewPanels();
        renderFiles();
        renderPreview();
        renderPropertiesPanel();
        applySidebarIconRules();
        scheduleWindowSessionSave();
    }

    applyTheme(state.theme);
    if (state.sidebarCollapsed) document.body.classList.add("sidebar-collapsed");
    const startupParams = new URLSearchParams(window.location.search);
    const initialPath = startupParams.get("path");
    const sessionToken = startupParams.get("session");

    nativeLog("info", "ui.startup", { initialPath: initialPath || "", hasSessionToken: Boolean(sessionToken) });

    if (sessionToken) {
        const applied = consumePendingWindowSession(sessionToken);
        if (!applied && initialPath) {
            applyStartupPathToTabs(initialPath);
        }
    } else if (initialPath) {
        applyStartupPathToTabs(initialPath);
    } else if (state.activeView === "explorer") {
        const restored = restoreWindowsFromLastSession();
        if (!restored) {
            try {
                const lastPath = localStorage.getItem("mmm-last-path") || "";
                if (lastPath) {
                    applyStartupPathToTabs(lastPath);
                }
            } catch (_err) {
            }
        }
    }
    await hydrateFileSystemFromNative();
    ensureDir(pathToString());
    addTimelineEntry("Initial State", cloneFileSystem());
    refreshAll();
    bindCrossWindowCommands();
    bindNativeBridgeEvents();
    bindFavoriteInteractions();
    bindMarqueeSelection();
    bindDropTargets();
    saveWindowSession();
    setInterval(() => saveWindowSession(), 15000);
    togglePreviewPane(state.previewVisible);
    renderTerminal();
    if (els.terminalLauncherBtn) {
        toggleTerminal(false);
    }

    if (els.themeToggle) {
        els.themeToggle.addEventListener("click", () => {
            applyTheme(state.theme === "dark" ? "light" : "dark");
        });
    }

    if (els.sidebarToggle) {
        els.sidebarToggle.addEventListener("click", () => {
            document.body.classList.toggle("sidebar-collapsed");
            localStorage.setItem("mmm-sidebar", document.body.classList.contains("sidebar-collapsed") ? "collapsed" : "expanded");
        });
    }

    if (els.newTabBtn) {
        els.newTabBtn.addEventListener("click", () => {
            addTab(pathToString());
        });
    }

    if (els.newWindowBtn) {
        els.newWindowBtn.addEventListener("click", () => {
            openInNewWindow(pathToString());
        });
    }

    if (els.addLocationBtn) {
        els.addLocationBtn.addEventListener("click", () => {
            showActionDialog({
                title: "Add Sidebar Location",
                message: "Enter folder path",
                defaultValue: "/Home/workspace/new-folder",
                placeholder: "/Home/workspace/new-folder",
                confirmLabel: "Add",
                requireInput: true,
                onConfirm: (location) => {
                    const normalized = normalizeAbsolutePath(location);
                    state.customLocations.push(normalized);
                    addFavorite(normalized);
                }
            });
        });
    }

    document.querySelectorAll(".section-toggle").forEach((btn) => {
        btn.addEventListener("click", () => {
            const target = document.getElementById(btn.dataset.target || "");
            if (target) target.classList.toggle("hidden");
        });
    });

    document.querySelectorAll(".nav-item[data-path]").forEach((item) => {
        item.addEventListener("click", (e) => {
            e.preventDefault();
            const raw = item.dataset.path;
            if (!raw) return;
            const normalized = normalizeAbsolutePath(raw);
            if (state.activeView === "settings") {
                window.location.href = `index.html?path=${encodeURIComponent(normalized)}`;
                return;
            }
            openPath(normalized);
        });
    });

    if (els.addressBar) {
        els.addressBar.addEventListener("dblclick", () => setPathInputMode(true));
        els.addressBar.addEventListener("contextmenu", (e) => {
            e.preventDefault();
            if (navigator.clipboard && navigator.clipboard.writeText) {
                navigator.clipboard.writeText(pathToString());
            }
        });
    }

    if (els.pathInput) {
        els.pathInput.addEventListener("keydown", (e) => {
            if (e.key === "Enter") {
                const normalized = els.pathInput.value.trim().replace(/^\/+/, "");
                const nextPath = normalized ? normalizeAbsolutePath(`/${normalized}`) : "/Home";
                openPath(nextPath);
                setPathInputMode(false);
            }
            if (e.key === "Escape") {
                setPathInputMode(false);
            }
        });
        els.pathInput.addEventListener("blur", () => setPathInputMode(false));
    }

    const backBtn = document.getElementById("backBtn");
    if (backBtn) {
        backBtn.addEventListener("click", () => {
            navigateHistory(-1);
        });
    }

    const forwardBtn = document.getElementById("forwardBtn");
    if (forwardBtn) {
        forwardBtn.addEventListener("click", () => {
            navigateHistory(1);
        });
    }

    if (els.viewModeToggle) {
        els.viewModeToggle.querySelectorAll("button").forEach((btn) => {
            btn.addEventListener("click", () => {
                state.viewMode = btn.dataset.mode || "grid";
                localStorage.setItem("mmm-view", state.viewMode);
                els.viewModeToggle.querySelectorAll("button").forEach((n) => n.classList.remove("active"));
                btn.classList.add("active");
                renderFiles();
            });
        });
        const activeBtn = els.viewModeToggle.querySelector(`button[data-mode="${state.viewMode}"]`);
        if (activeBtn) {
            els.viewModeToggle.querySelectorAll("button").forEach((n) => n.classList.remove("active"));
            activeBtn.classList.add("active");
        }
    }

    const splitToggle = document.getElementById("splitToggle");
    if (splitToggle && els.workspace) {
        splitToggle.addEventListener("click", () => {
            state.split = !state.split;
            els.workspace.classList.toggle("split", state.split);
            if (state.split && !document.getElementById("explorerClone")) {
                const clone = els.explorerPanel ? els.explorerPanel.cloneNode(true) : null;
                if (clone) {
                    clone.id = "explorerClone";
                    clone.classList.remove("hidden");
                    const badges = clone.querySelector(".status-badges");
                    if (badges) badges.innerHTML = "<span class='badge'>Split Pane B</span>";
                    els.workspace.insertBefore(clone, els.previewPane);
                }
            } else {
                const clone = document.getElementById("explorerClone");
                if (clone) clone.remove();
            }
        });
    }

    const refreshBtn = document.getElementById("refreshBtn");
    if (refreshBtn) {
        refreshBtn.addEventListener("click", performRefresh);
    }

    const recentsBtn = document.getElementById("recentsBtn");
    if (recentsBtn) {
        recentsBtn.addEventListener("click", () => {
            state.items = [...state.items].sort((a, b) => b.modified.localeCompare(a.modified));
            renderFiles();
        });
    }

    if (els.previewToggle) {
        els.previewToggle.addEventListener("click", () => {
            togglePreviewPane();
        });
    }

    if (els.previewPaneToggle) {
        els.previewPaneToggle.addEventListener("click", () => {
            togglePreviewPane();
        });
    }

    const newFolderBtn = document.getElementById("newFolderBtn");
    if (newFolderBtn) {
        newFolderBtn.addEventListener("click", () => {
            openDialog(els.newFolderDialog, els.newFolderNameInput, "new-folder");
        });
    }

    if (els.newFileBtn) {
        els.newFileBtn.addEventListener("click", () => {
            openDialog(els.newFileDialog, els.newFileNameInput, "untitled.txt");
        });
    }

    const searchToggle = document.getElementById("searchToggle");
    if (searchToggle) {
        searchToggle.addEventListener("click", openSpotlight);
    }

    if (els.spotlight) {
        els.spotlight.addEventListener("click", (e) => {
            if (e.target === els.spotlight) closeSpotlight();
        });
    }

    if (els.spotlightInput) {
        els.spotlightInput.addEventListener("input", () => runSearch(els.spotlightInput.value.trim()));
    }

    document.querySelectorAll(".spotlight-options button").forEach((btn) => {
        btn.addEventListener("click", () => {
            if (!els.spotlightInput) return;
            const append = btn.dataset.filter || "";
            els.spotlightInput.value = `${els.spotlightInput.value} ${append}`.trim();
            runSearch(els.spotlightInput.value.trim());
            els.spotlightInput.focus();
        });
    });

    if (els.contextMenu) {
        els.contextMenu.querySelectorAll("li").forEach((li) => {
            li.addEventListener("click", () => {
                onContextAction(li.dataset.action || "");
                closeContextMenu();
            });
        });
    }

    window.addEventListener("keydown", (e) => {
        if (e.key === "Shift") state.shiftHeld = true;
    });
    window.addEventListener("keyup", (e) => {
        if (e.key === "Shift") state.shiftHeld = false;
    });
    window.addEventListener("blur", () => {
        state.shiftHeld = false;
        state.dragKind = null;
        state.dragPayload = null;
        state.draggedItemIndex = null;
        state.draggedFavoriteIndex = null;
    });

    document.addEventListener("click", () => closeContextMenu());
    document.addEventListener("keydown", handleKeyboard);

    const themeSelect = document.getElementById("themeSelect");
    if (themeSelect) {
        themeSelect.value = state.theme;
        themeSelect.addEventListener("change", () => applyTheme(themeSelect.value));
    }

    const autoHideCheckbox = document.getElementById("autoHideCheckbox");
    if (autoHideCheckbox) {
        autoHideCheckbox.checked = true;
        autoHideCheckbox.addEventListener("change", () => {
            if (!autoHideCheckbox.checked) {
                document.body.classList.remove("sidebar-collapsed");
            }
        });
    }

    const defaultViewSelect = document.getElementById("defaultViewSelect");
    if (defaultViewSelect) {
        defaultViewSelect.value = state.viewMode;
        defaultViewSelect.addEventListener("change", () => {
            state.viewMode = defaultViewSelect.value;
            localStorage.setItem("mmm-view", state.viewMode);
            renderFiles();
        });
    }

    const settingsTabs = document.getElementById("settingsTabs");
    if (settingsTabs) {
        settingsTabs.querySelectorAll("button[data-settings-tab]").forEach((btn) => {
            btn.addEventListener("click", () => {
                const target = btn.getAttribute("data-settings-tab");
                settingsTabs.querySelectorAll("button[data-settings-tab]").forEach((b) => b.classList.remove("active"));
                btn.classList.add("active");
                document.querySelectorAll(".settings-section[data-settings-section]").forEach((section) => {
                    section.classList.toggle("hidden", section.getAttribute("data-settings-section") !== target);
                });
            });
        });
    }

    if (els.sysRefreshInfoBtn) {
        els.sysRefreshInfoBtn.addEventListener("click", () => {
            void refreshSystemInfo();
        });
    }

    if (els.sysApplyRootBtn) {
        els.sysApplyRootBtn.addEventListener("click", async () => {
            if (!window.MJSI || typeof window.MJSI.invoke !== "function") {
                showOperationPopup("System", "Native host not connected.");
                return;
            }

            const raw = (els.sysRealRoot ? String(els.sysRealRoot.value || "") : "").trim();
            if (!raw) {
                showOperationPopup("Root Mapping", "Mapped Real Root is empty.");
                return;
            }

            if (raw === "/" && !appConfirm("Set root to '/'? This would expose the entire filesystem to MMM.")) {
                return;
            }

            const res = await window.MJSI.invoke("fs.setRoot", { realRoot: raw });
            if (!res || res.ok !== true) {
                const err = res && res.error ? `${res.error.code || ""} ${res.error.message || ""}`.trim() : "Unknown error";
                showOperationPopup("Root Mapping Failed", err);
                return;
            }

            showOperationPopup("Root Mapping", `Now mapping ${res.virtualRoot || "/Home"} -> ${res.realRootDisplay || res.realRootStored || res.realRoot || raw}`);
            openPath("/Home");
            void refreshSystemInfo();
        });
    }

    if (els.sysResetRootBtn) {
        els.sysResetRootBtn.addEventListener("click", () => {
            if (els.sysRealRoot) els.sysRealRoot.value = "~";
            if (els.sysApplyRootBtn) els.sysApplyRootBtn.click();
        });
    }

    void refreshSystemInfo();

    const shortcutSpotlight = document.getElementById("shortcutSpotlight");
    const shortcutNewTab = document.getElementById("shortcutNewTab");
    const shortcutNewFolder = document.getElementById("shortcutNewFolder");
    const shortcutNewFile = document.getElementById("shortcutNewFile");
    const shortcutRefresh = document.getElementById("shortcutRefresh");
    const shortcutPreview = document.getElementById("shortcutPreview");
    const shortcutBack = document.getElementById("shortcutBack");
    const shortcutForward = document.getElementById("shortcutForward");
    const shortcutCopy = document.getElementById("shortcutCopy");
    const shortcutCut = document.getElementById("shortcutCut");
    const shortcutPaste = document.getElementById("shortcutPaste");
    const shortcutUndo = document.getElementById("shortcutUndo");
    const shortcutRedo = document.getElementById("shortcutRedo");
    const shortcutRename = document.getElementById("shortcutRename");
    const shortcutDelete = document.getElementById("shortcutDelete");
    const shortcutSelectAll = document.getElementById("shortcutSelectAll");
    const shortcutDuplicate = document.getElementById("shortcutDuplicate");
    const shortcutHistory = document.getElementById("shortcutHistory");
    const shortcutTerminal = document.getElementById("shortcutTerminal");

    if (shortcutSpotlight) shortcutSpotlight.value = state.shortcuts.spotlight;
    if (shortcutNewTab) shortcutNewTab.value = state.shortcuts.newTab;
    if (shortcutNewFolder) shortcutNewFolder.value = state.shortcuts.newFolder;
    if (shortcutNewFile) shortcutNewFile.value = state.shortcuts.newFile;
    if (shortcutRefresh) shortcutRefresh.value = state.shortcuts.refresh;
    if (shortcutPreview) shortcutPreview.value = state.shortcuts.togglePreview;
    if (shortcutBack) shortcutBack.value = state.shortcuts.back;
    if (shortcutForward) shortcutForward.value = state.shortcuts.forward;
    if (shortcutCopy) shortcutCopy.value = state.shortcuts.copy;
    if (shortcutCut) shortcutCut.value = state.shortcuts.cut;
    if (shortcutPaste) shortcutPaste.value = state.shortcuts.paste;
    if (shortcutUndo) shortcutUndo.value = state.shortcuts.undo;
    if (shortcutRedo) shortcutRedo.value = state.shortcuts.redo;
    if (shortcutRename) shortcutRename.value = state.shortcuts.rename;
    if (shortcutDelete) shortcutDelete.value = state.shortcuts.del;
    if (shortcutSelectAll) shortcutSelectAll.value = state.shortcuts.selectAll;
    if (shortcutDuplicate) shortcutDuplicate.value = state.shortcuts.duplicate;
    if (shortcutHistory) shortcutHistory.value = state.shortcuts.toggleHistory;
    if (shortcutTerminal) shortcutTerminal.value = state.shortcuts.toggleTerminal;

    const bindShortcutInput = (input, key) => {
        if (!input) return;
        input.addEventListener("blur", () => {
            state.shortcuts[key] = normalizeShortcut(input.value || "");
            input.value = state.shortcuts[key];
            persistShortcuts();
        });
    };

    bindShortcutInput(shortcutSpotlight, "spotlight");
    bindShortcutInput(shortcutNewTab, "newTab");
    bindShortcutInput(shortcutNewFolder, "newFolder");
    bindShortcutInput(shortcutNewFile, "newFile");
    bindShortcutInput(shortcutRefresh, "refresh");
    bindShortcutInput(shortcutPreview, "togglePreview");
    bindShortcutInput(shortcutBack, "back");
    bindShortcutInput(shortcutForward, "forward");
    bindShortcutInput(shortcutCopy, "copy");
    bindShortcutInput(shortcutCut, "cut");
    bindShortcutInput(shortcutPaste, "paste");
    bindShortcutInput(shortcutUndo, "undo");
    bindShortcutInput(shortcutRedo, "redo");
    bindShortcutInput(shortcutRename, "rename");
    bindShortcutInput(shortcutDelete, "del");
    bindShortcutInput(shortcutSelectAll, "selectAll");
    bindShortcutInput(shortcutDuplicate, "duplicate");
    bindShortcutInput(shortcutHistory, "toggleHistory");
    bindShortcutInput(shortcutTerminal, "toggleTerminal");

    if (els.contextExpandedCheckbox) {
        els.contextExpandedCheckbox.checked = state.contextExpanded;
        els.contextExpandedCheckbox.addEventListener("change", () => {
            state.contextExpanded = Boolean(els.contextExpandedCheckbox.checked);
            localStorage.setItem("mmm-context-expanded", state.contextExpanded ? "1" : "0");
            applyContextMenuPresentation();
        });
    }

    if (els.contextActionsInput) {
        const effective = { ...baseContextActionDefaults, ...state.contextActionConfig };
        els.contextActionsInput.value = JSON.stringify(effective, null, 2);
    }

    if (els.saveContextActionsBtn) {
        els.saveContextActionsBtn.addEventListener("click", () => {
            if (!els.contextActionsInput) return;
            try {
                const parsed = JSON.parse(els.contextActionsInput.value || "{}");
                state.contextActionConfig = parsed;
                localStorage.setItem("mmm-context-actions", JSON.stringify(parsed));
                applyContextMenuPresentation();
                showOperationPopup("Context Actions Saved", "Updated existing right-click actions.");
            } catch (_err) {
                showOperationPopup("Invalid JSON", "Context Actions JSON could not be parsed.");
            }
        });
    }

    if (els.customContextActionsInput) {
        els.customContextActionsInput.value = JSON.stringify(state.customContextActions, null, 2);
    }

    if (els.saveCustomContextActionsBtn) {
        els.saveCustomContextActionsBtn.addEventListener("click", () => {
            if (!els.customContextActionsInput) return;
            try {
                const parsed = JSON.parse(els.customContextActionsInput.value || "[]");
                state.customContextActions = Array.isArray(parsed) ? parsed : [];
                localStorage.setItem("mmm-custom-context-actions", JSON.stringify(state.customContextActions));
                buildCustomContextItems();
                applyContextMenuPresentation();
                showOperationPopup("Custom Actions Saved", "Added/updated custom right-click actions.");
            } catch (_err) {
                showOperationPopup("Invalid JSON", "Custom Actions JSON could not be parsed.");
            }
        });
    }

    const addTemplateAction = (template) => {
        const exists = state.customContextActions.some((item) => item.id === template.id);
        if (!exists) {
            state.customContextActions.push(template);
            localStorage.setItem("mmm-custom-context-actions", JSON.stringify(state.customContextActions));
            if (els.customContextActionsInput) {
                els.customContextActionsInput.value = JSON.stringify(state.customContextActions, null, 2);
            }
            buildCustomContextItems();
            applyContextMenuPresentation();
            showOperationPopup("Template Added", template.label);
        }
    };

    if (els.addTemplateVsCodeBtn) {
        els.addTemplateVsCodeBtn.addEventListener("click", () => {
            addTemplateAction({
                id: "open-with-vscode",
                label: "Open with VS Code",
                icon: "icon-file-code",
                command: "open:vscode://file/{{path}}",
                requiresSelection: true
            });
        });
    }

    if (els.addTemplateTerminalBtn) {
        els.addTemplateTerminalBtn.addEventListener("click", () => {
            addTemplateAction({
                id: "open-terminal-here",
                label: "Open Terminal Here",
                icon: "icon-terminal",
                command: "alert:Terminal hookup placeholder for {{path}}",
                requiresSelection: false
            });
        });
    }

    if (els.addTemplateBrowserBtn) {
        els.addTemplateBrowserBtn.addEventListener("click", () => {
            addTemplateAction({
                id: "open-in-browser",
                label: "Open in Browser",
                icon: "icon-search",
                command: "open:{{path}}",
                requiresSelection: true
            });
        });
    }

    if (els.fileIconRulesInput) {
        els.fileIconRulesInput.value = JSON.stringify(state.fileIconRules, null, 2);
    }

    if (els.saveFileIconRulesBtn) {
        els.saveFileIconRulesBtn.addEventListener("click", () => {
            if (!els.fileIconRulesInput) return;
            try {
                const parsed = JSON.parse(els.fileIconRulesInput.value || "{}");
                state.fileIconRules = parsed;
                localStorage.setItem("mmm-file-icon-rules", JSON.stringify(parsed));
                renderFiles();
                showOperationPopup("File Icon Rules Saved", "Applied extension-to-icon mapping.");
            } catch (_err) {
                showOperationPopup("Invalid JSON", "File Icon Rules JSON could not be parsed.");
            }
        });
    }

    if (els.sidebarIconRulesInput) {
        els.sidebarIconRulesInput.value = JSON.stringify(state.sidebarIconRules, null, 2);
    }

    if (els.saveSidebarIconRulesBtn) {
        els.saveSidebarIconRulesBtn.addEventListener("click", () => {
            if (!els.sidebarIconRulesInput) return;
            try {
                const parsed = JSON.parse(els.sidebarIconRulesInput.value || "{}");
                state.sidebarIconRules = parsed;
                localStorage.setItem("mmm-sidebar-icon-rules", JSON.stringify(parsed));
                applySidebarIconRules();
                showOperationPopup("Sidebar Icon Rules Saved", "Applied icon mapping to sidebar entries.");
            } catch (_err) {
                showOperationPopup("Invalid JSON", "Sidebar Icon Rules JSON could not be parsed.");
            }
        });
    }

    renderImportedIcons();

    if (els.importIconFileBtn) {
        els.importIconFileBtn.addEventListener("click", () => {
            if (!els.iconImportFileInput) return;
            const keyRaw = els.iconImportKeyInput?.value || "";
            const file = els.iconImportFileInput.files?.[0];
            if (!file) {
                showOperationPopup("Icon Import", "Choose a png, jpg, or svg file first.");
                return;
            }
            const lower = file.name.toLowerCase();
            const isSvg = lower.endsWith(".svg") || file.type === "image/svg+xml";
            const isRaster = lower.endsWith(".png") || lower.endsWith(".jpg") || lower.endsWith(".jpeg") || file.type === "image/png" || file.type === "image/jpeg";
            if (!isSvg && !isRaster) {
                showOperationPopup("Icon Import", "Only png, jpg, jpeg, and svg are supported.");
                return;
            }
            const reader = new FileReader();
            if (isSvg) {
                reader.onload = () => {
                    const markup = String(reader.result || "").trim();
                    if (!markup.includes("<svg")) {
                        showOperationPopup("Icon Import", "That SVG file could not be parsed.");
                        return;
                    }
                    saveImportedIcon(keyRaw, svgMarkupToDataUrl(markup));
                    els.iconImportFileInput.value = "";
                };
                reader.readAsText(file);
                return;
            }
            reader.onload = () => {
                const dataUrl = String(reader.result || "");
                if (!dataUrl.startsWith("data:image/")) {
                    showOperationPopup("Icon Import", "File did not produce a valid image data URL.");
                    return;
                }
                saveImportedIcon(keyRaw, dataUrl);
                els.iconImportFileInput.value = "";
            };
            reader.readAsDataURL(file);
        });
    }

    if (els.importIconSvgBtn) {
        els.importIconSvgBtn.addEventListener("click", () => {
            const keyRaw = els.iconImportKeyInput?.value || "";
            const markup = (els.iconImportSvgInput?.value || "").trim();
            if (!markup || !markup.includes("<svg")) {
                showOperationPopup("Icon Import", "Paste valid SVG markup first.");
                return;
            }
            saveImportedIcon(keyRaw, svgMarkupToDataUrl(markup));
            if (els.iconImportSvgInput) els.iconImportSvgInput.value = "";
        });
    }

    if (els.ioHistoryEnabledCheckbox) {
        els.ioHistoryEnabledCheckbox.checked = state.ioHistoryEnabled;
        els.ioHistoryEnabledCheckbox.addEventListener("change", () => {
            state.ioHistoryEnabled = Boolean(els.ioHistoryEnabledCheckbox.checked);
            localStorage.setItem("mmm-io-history-enabled", state.ioHistoryEnabled ? "1" : "0");
            if (!state.ioHistoryEnabled) {
                state.ioHistory.undoStack = [];
                state.ioHistory.redoStack = [];
                state.ioTimeline = [];
                state.ioTimelineIndex = -1;
                renderHistoryTimeline();
            } else {
                addTimelineEntry("History Enabled", cloneFileSystem());
            }
            showOperationPopup("IO History", state.ioHistoryEnabled ? "IO history enabled." : "IO history disabled.");
        });
    }

    if (els.ioHistoryLimitInput) {
        els.ioHistoryLimitInput.value = String(state.ioHistoryLimit);
        els.ioHistoryLimitInput.addEventListener("change", () => {
            const v = Math.max(10, Math.min(500, Number(els.ioHistoryLimitInput.value) || 140));
            state.ioHistoryLimit = v;
            els.ioHistoryLimitInput.value = String(v);
            localStorage.setItem("mmm-io-history-limit", String(v));
            state.ioHistory.undoStack = state.ioHistory.undoStack.slice(-v);
        });
    }

    if (els.ioTimelineLimitInput) {
        els.ioTimelineLimitInput.value = String(state.ioTimelineLimit);
        els.ioTimelineLimitInput.addEventListener("change", () => {
            const v = Math.max(10, Math.min(500, Number(els.ioTimelineLimitInput.value) || 140));
            state.ioTimelineLimit = v;
            els.ioTimelineLimitInput.value = String(v);
            localStorage.setItem("mmm-io-timeline-limit", String(v));
            state.ioTimeline = state.ioTimeline.slice(-v);
            state.ioTimelineIndex = Math.min(state.ioTimelineIndex, state.ioTimeline.length - 1);
            renderHistoryTimeline();
        });
    }

    if (els.recycleRetentionDaysInput) {
        els.recycleRetentionDaysInput.value = String(state.recycleRetentionDays);
        els.recycleRetentionDaysInput.addEventListener("change", () => {
            const v = Math.max(1, Math.min(3650, Number(els.recycleRetentionDaysInput.value) || 30));
            state.recycleRetentionDays = v;
            els.recycleRetentionDaysInput.value = String(v);
            localStorage.setItem("mmm-recycle-retention-days", String(v));
            pruneRecycleBin();
            refreshAll();
        });
    }

    if (els.recycleMaxItemsInput) {
        els.recycleMaxItemsInput.value = String(state.recycleMaxItems);
        els.recycleMaxItemsInput.addEventListener("change", () => {
            const v = Math.max(10, Math.min(50000, Number(els.recycleMaxItemsInput.value) || 1000));
            state.recycleMaxItems = v;
            els.recycleMaxItemsInput.value = String(v);
            localStorage.setItem("mmm-recycle-max-items", String(v));
            pruneRecycleBin();
            refreshAll();
        });
    }

    if (els.queuePauseBtn) {
        updateQueueControlsUI();
        els.queuePauseBtn.addEventListener("click", () => {
            state.operationQueuePaused = !state.operationQueuePaused;
            updateQueueControlsUI();
            if (!state.operationQueuePaused) {
                processOperationQueue();
            }
        });
    }

    if (els.queueClearBtn) {
        els.queueClearBtn.addEventListener("click", () => {
            const pending = state.operationQueue.length;
            state.operationQueue = [];
            updateQueueControlsUI();
            showOperationPopup("Operation Queue", `Cleared ${pending} pending operation(s).`);
        });
    }

    if (els.historyToggleBtn && els.historyPanel) {
        els.historyToggleBtn.addEventListener("click", () => {
            els.historyPanel.classList.toggle("hidden");
            renderHistoryTimeline();
        });
    }

    if (els.historyCloseBtn && els.historyPanel) {
        els.historyCloseBtn.addEventListener("click", () => {
            els.historyPanel.classList.add("hidden");
        });
    }

    if (els.newFolderCancelBtn) {
        els.newFolderCancelBtn.addEventListener("click", () => closeDialog(els.newFolderDialog));
    }

    if (els.newFolderCreateBtn) {
        els.newFolderCreateBtn.addEventListener("click", () => {
            createFolderHere(els.newFolderNameInput?.value || "");
            closeDialog(els.newFolderDialog);
        });
    }

    if (els.newFolderNameInput) {
        els.newFolderNameInput.addEventListener("keydown", (e) => {
            if (e.key === "Enter") {
                createFolderHere(els.newFolderNameInput.value || "");
                closeDialog(els.newFolderDialog);
            } else if (e.key === "Escape") {
                closeDialog(els.newFolderDialog);
            }
        });
    }

    if (els.newFileCancelBtn) {
        els.newFileCancelBtn.addEventListener("click", () => closeDialog(els.newFileDialog));
    }

    if (els.newFileCreateBtn) {
        els.newFileCreateBtn.addEventListener("click", () => {
            createFileHere(els.newFileNameInput?.value || "");
            closeDialog(els.newFileDialog);
        });
    }

    if (els.newFileNameInput) {
        els.newFileNameInput.addEventListener("keydown", (e) => {
            if (e.key === "Enter") {
                createFileHere(els.newFileNameInput.value || "");
                closeDialog(els.newFileDialog);
            } else if (e.key === "Escape") {
                closeDialog(els.newFileDialog);
            }
        });
    }

    if (els.operationUndoBtn) {
        els.operationUndoBtn.addEventListener("click", undoLastOperation);
    }

    if (els.operationRedoBtn) {
        els.operationRedoBtn.addEventListener("click", redoLastOperation);
    }

    if (els.operationPopupCloseBtn) {
        els.operationPopupCloseBtn.addEventListener("click", () => {
            if (els.operationPopup) els.operationPopup.classList.add("hidden");
        });
    }

    if (els.operationPopup) {
        els.operationPopup.addEventListener("mouseenter", () => {
            if (state.popupFadeTimer) window.clearTimeout(state.popupFadeTimer);
            if (state.popupHideTimer) window.clearTimeout(state.popupHideTimer);
            els.operationPopup.classList.remove("fading");
            els.operationPopup.classList.remove("hidden");
        });
        els.operationPopup.addEventListener("mouseleave", () => {
            schedulePopupFade();
        });
    }

    if (els.terminalLauncherBtn) {
        els.terminalLauncherBtn.addEventListener("click", () => toggleTerminal());
    }

    const persistedTerminalHeight = Number(localStorage.getItem("mmm-terminal-height") || "190");
    setTerminalHeight(persistedTerminalHeight);
    bindTerminalResizer();
    pruneRecycleBin();
    if (!Array.isArray(state.navHistory)) {
        state.navHistory = [];
    }
    if (state.navHistoryIndex < 0 || state.navHistoryIndex >= state.navHistory.length) {
        state.navHistoryIndex = state.navHistory.length - 1;
    }
    if (!state.navHistory.length) {
        rememberPath(pathToString());
    } else if (state.navHistory[state.navHistoryIndex] !== pathToString()) {
        rememberPath(pathToString());
    }

    if (els.terminalRunBtn && els.terminalInput) {
        els.terminalRunBtn.addEventListener("click", () => {
            void runTerminalCommand(els.terminalInput.value);
            els.terminalInput.value = "";
            els.terminalInput.focus();
        });
        els.terminalInput.addEventListener("keydown", (e) => {
            if (e.key === "Enter") {
                void runTerminalCommand(els.terminalInput.value);
                els.terminalInput.value = "";
            } else if (e.key === "ArrowUp") {
                e.preventDefault();
                if (!state.terminalHistory.length) return;
                state.terminalHistoryIndex = Math.max(0, state.terminalHistoryIndex - 1);
                els.terminalInput.value = state.terminalHistory[state.terminalHistoryIndex] || "";
            } else if (e.key === "ArrowDown") {
                e.preventDefault();
                if (!state.terminalHistory.length) return;
                state.terminalHistoryIndex = Math.min(state.terminalHistory.length, state.terminalHistoryIndex + 1);
                els.terminalInput.value = state.terminalHistory[state.terminalHistoryIndex] || "";
            } else if (e.key === "Tab") {
                e.preventDefault();
                const raw = els.terminalInput.value || "";
                const pieces = raw.split(/\s+/);
                const last = pieces[pieces.length - 1] || "";
                const matches = terminalCompletions(last);
                if (matches.length === 1) {
                    pieces[pieces.length - 1] = matches[0];
                    els.terminalInput.value = pieces.join(" ");
                } else if (matches.length > 1) {
                    appendTerminalLine(`completions: ${matches.join(", ")}`);
                }
            }
        });
    }

    buildCustomContextItems();
    applyContextMenuPresentation();

    renderHistoryTimeline();
});
