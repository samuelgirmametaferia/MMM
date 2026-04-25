(function () {
    const LOCAL_CONFIG_KEY = "mmm:state:config";
    const LOCAL_FS_KEY = "mmm:state:filesystem";

    const listeners = new Map();
    let nativeMirrorSuppressed = false;

    function on(eventName, handler) {
        if (!listeners.has(eventName)) listeners.set(eventName, new Set());
        listeners.get(eventName).add(handler);
        return function unsubscribe() {
            listeners.get(eventName)?.delete(handler);
        };
    }

    function emit(eventName, payload) {
        const handlers = listeners.get(eventName);
        if (!handlers) return;
        handlers.forEach((handler) => {
            try {
                handler(payload);
            } catch (_err) {
                // Do not let listener errors break bridge fan-out.
            }
        });
    }

    async function invoke(action, payload) {
        const host = window.mmmHost;
        if (!host) return null;

        if (typeof host.invoke === "function") {
            return host.invoke(action, payload || {});
        }
        if (typeof host.call === "function") {
            return host.call(action, payload || {});
        }

        const fallbackMethod = action.replace(/\./g, "_");
        if (typeof host[fallbackMethod] === "function") {
            return host[fallbackMethod](payload || {});
        }
        return null;
    }

    async function persistKV(key, value) {
        try {
            await invoke("config.set", { key, value: String(value ?? "") });
        } catch (_err) {
            // Native persistence is best-effort; localStorage remains source of truth in fallback mode.
        }
    }

    async function removeKV(key) {
        try {
            await invoke("config.remove", { key });
        } catch (_err) {
            // Ignore native delete errors in web fallback mode.
        }
    }

    async function hydrateLocalStorageFromNative() {
        let nativeState = null;
        try {
            nativeState = await invoke("config.getAll", { namespace: "mmm" });
        } catch (_err) {
            nativeState = null;
        }

        if (!nativeState || typeof nativeState !== "object") return;

        nativeMirrorSuppressed = true;
        try {
            Object.entries(nativeState).forEach(([k, v]) => {
                if (typeof k !== "string") return;
                localStorage.setItem(k, typeof v === "string" ? v : JSON.stringify(v));
            });
        } finally {
            nativeMirrorSuppressed = false;
        }
    }

    function installLocalStorageMirror() {
        const originalSetItem = localStorage.setItem.bind(localStorage);
        const originalRemoveItem = localStorage.removeItem.bind(localStorage);

        localStorage.setItem = function setItemPatched(key, value) {
            originalSetItem(key, value);
            if (!nativeMirrorSuppressed) {
                void persistKV(key, value);
            }
        };

        localStorage.removeItem = function removeItemPatched(key) {
            originalRemoveItem(key);
            if (!nativeMirrorSuppressed) {
                void removeKV(key);
            }
        };
    }

    async function getFileSystemSnapshot() {
        try {
            const nativeSnapshot = await invoke("fs.snapshot", {});
            if (nativeSnapshot && typeof nativeSnapshot === "object") {
                localStorage.setItem(LOCAL_FS_KEY, JSON.stringify(nativeSnapshot));
                return nativeSnapshot;
            }
        } catch (_err) {
            // Fall through to local snapshot cache.
        }

        try {
            const cached = localStorage.getItem(LOCAL_FS_KEY);
            return cached ? JSON.parse(cached) : null;
        } catch (_err) {
            return null;
        }
    }

    async function seedFileSystem(snapshot) {
        if (!snapshot || typeof snapshot !== "object") return;
        localStorage.setItem(LOCAL_FS_KEY, JSON.stringify(snapshot));
        try {
            await invoke("fs.seed", { snapshot });
        } catch (_err) {
            // Seeding is optional in web-only mode.
        }
    }

    async function applyFileOperation(operation) {
        if (!operation || typeof operation !== "object") return null;
        if (operation.snapshot) {
            localStorage.setItem(LOCAL_FS_KEY, JSON.stringify(operation.snapshot));
        }

        const payload = {
            operation,
            dispatch: {
                priority: "user-blocking",
                allowParallel: true,
                pool: "io"
            }
        };

        try {
            const result = await invoke("fs.applyOperation", payload);
            return result;
        } catch (_err) {
            return null;
        }
    }

    async function readConfig() {
        try {
            const raw = localStorage.getItem(LOCAL_CONFIG_KEY);
            return raw ? JSON.parse(raw) : {};
        } catch (_err) {
            return {};
        }
    }

    async function writeConfig(nextConfig) {
        const safe = nextConfig && typeof nextConfig === "object" ? nextConfig : {};
        localStorage.setItem(LOCAL_CONFIG_KEY, JSON.stringify(safe));
        try {
            await invoke("config.writeStructured", { key: "mmm.config", value: safe });
        } catch (_err) {
            // Structured write is optional if host does not support it yet.
        }
    }

    function bindNativeEvents() {
        const host = window.mmmHost;
        if (!host) return;

        if (typeof host.onEvent === "function") {
            host.onEvent(function handleHostEvent(evt) {
                if (!evt || typeof evt !== "object") return;
                emit(String(evt.type || "unknown"), evt.payload || {});
            });
            return;
        }

        if (typeof host.subscribe === "function") {
            try {
                host.subscribe("fs.changed", function (payload) {
                    emit("fs.changed", payload || {});
                });
                host.subscribe("config.changed", function (payload) {
                    emit("config.changed", payload || {});
                });
            } catch (_err) {
                // Host may not support subscriptions in browser fallback.
            }
        }
    }

    const ready = (async function bootstrap() {
        installLocalStorageMirror();
        await hydrateLocalStorageFromNative();
        bindNativeEvents();

        const existing = await readConfig();
        if (!existing.createdAt) {
            await writeConfig({
                createdAt: new Date().toISOString(),
                schemaVersion: 1,
                lastBootstrapMode: window.mmmHost ? "native" : "web-fallback"
            });
        }
    })();

    window.MJSI = {
        ready,
        on,
        emit,
        invoke,
        persistKV,
        removeKV,
        getFileSystemSnapshot,
        seedFileSystem,
        applyFileOperation,
        readConfig,
        writeConfig,
        isNative: function isNative() {
            return Boolean(window.mmmHost);
        }
    };
})();
