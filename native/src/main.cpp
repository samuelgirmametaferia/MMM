#include <algorithm>
#include <atomic>
#include <cctype>
#include <cerrno>
#include <chrono>
#include <condition_variable>
#include <cstdint>
#include <cstring>
#include <cstdlib>
#include <ctime>
#include <filesystem>
#include <fstream>
#include <functional>
#include <future>
#include <iomanip>
#include <iostream>
#include <iterator>
#include <mutex>
#include <optional>
#include <queue>
#include <sstream>
#include <string>
#include <thread>
#include <type_traits>
#include <unordered_map>
#include <utility>
#include <vector>

#ifdef MMM_PLATFORM_LINUX
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <signal.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>
#endif

#include <nlohmann/json.hpp>
#include <webview/webview.h>

#ifdef MMM_PLATFORM_LINUX
#include <gtk/gtk.h>
#endif

using json = nlohmann::json;
namespace fs = std::filesystem;

class ThreadPool {
public:
    explicit ThreadPool(std::size_t threadCount) : stop_(false) {
        workers_.reserve(threadCount);
        for (std::size_t i = 0; i < threadCount; ++i) {
            workers_.emplace_back([this]() {
                for (;;) {
                    std::function<void()> task;
                    {
                        std::unique_lock<std::mutex> lock(mutex_);
                        cv_.wait(lock, [this]() { return stop_ || !tasks_.empty(); });
                        if (stop_ && tasks_.empty()) {
                            return;
                        }
                        task = std::move(tasks_.front());
                        tasks_.pop();
                    }
                    task();
                }
            });
        }
    }

    ~ThreadPool() {
        {
            std::lock_guard<std::mutex> lock(mutex_);
            stop_ = true;
        }
        cv_.notify_all();
        for (auto &worker : workers_) {
            if (worker.joinable()) {
                worker.join();
            }
        }
    }

    template <typename Fn>
    auto enqueue(Fn &&fn) -> std::future<typename std::invoke_result_t<Fn>> {
        using ResultT = typename std::invoke_result_t<Fn>;
        auto task = std::make_shared<std::packaged_task<ResultT()>>(std::forward<Fn>(fn));
        std::future<ResultT> future = task->get_future();
        {
            std::lock_guard<std::mutex> lock(mutex_);
            tasks_.emplace([task]() { (*task)(); });
        }
        cv_.notify_one();
        return future;
    }

private:
    std::vector<std::thread> workers_;
    std::queue<std::function<void()>> tasks_;
    std::mutex mutex_;
    std::condition_variable cv_;
    bool stop_;
};

struct Paths {
    fs::path home;
    fs::path configDir;
    fs::path stateDir;
    fs::path cacheDir;
    fs::path logDir;
    fs::path kvConfigFile;
    fs::path structuredConfigFile;
    fs::path snapshotFile;
    fs::path logFile;
};

static std::string getHomePath() {
    const char *home = std::getenv("HOME");
    if (home && *home) return std::string(home);
    return "/tmp";
}

static Paths resolvePaths() {
    Paths p;
    p.home = fs::path(getHomePath());
    p.configDir = p.home / ".config" / "mmm";
    p.stateDir = p.home / ".local" / "share" / "mmm" / "state";
    p.cacheDir = p.home / ".cache" / "mmm";
    p.logDir = p.home / ".local" / "share" / "mmm" / "logs";
    p.kvConfigFile = p.configDir / "config_kv.json";
    p.structuredConfigFile = p.configDir / "config_structured.json";
    p.snapshotFile = p.stateDir / "filesystem_snapshot.json";
    p.logFile = p.logDir / "mmm.log";
    fs::create_directories(p.configDir);
    fs::create_directories(p.stateDir);
    fs::create_directories(p.cacheDir);
    fs::create_directories(p.logDir);
    return p;
}

static std::string readTextFile(const fs::path &path) {
    std::ifstream in(path, std::ios::binary);
    if (!in) return std::string();
    return std::string(std::istreambuf_iterator<char>(in), std::istreambuf_iterator<char>());
}

class Logger {
public:
    explicit Logger(fs::path logFile) : logFile_(std::move(logFile)) {}

    const fs::path &path() const {
        return logFile_;
    }

    void log(const std::string &level,
             const std::string &source,
             const std::string &event,
             const std::string &message = std::string(),
             const json &data = json::object()) {
        std::lock_guard<std::mutex> lock(mutex_);

        try {
            rotateIfNeededLocked();

            std::ofstream out(logFile_, std::ios::app);
            if (!out) return;

            json entry = json::object();
            entry["ts"] = isoNow();
            entry["level"] = sanitize(level, 24);
            entry["source"] = sanitize(source, 32);
            entry["event"] = sanitize(event, 64);
            if (!message.empty()) entry["message"] = sanitize(message, 4096);
            if (!data.is_null()) entry["data"] = summarizeJson(data, 2, 8);

            out << entry.dump() << "\n";
        } catch (...) {
            // Never throw from logging.
        }
    }

    static json summarizeJson(const json &value, int depth, int maxItems) {
        if (depth <= 0) {
            if (value.is_string()) return sanitize(value.get<std::string>(), 256);
            if (value.is_number() || value.is_boolean() || value.is_null()) return value;
            if (value.is_array()) return json::object({{"type", "array"}, {"size", value.size()}});
            if (value.is_object()) return json::object({{"type", "object"}, {"keys", value.size()}});
            return json::object({{"type", "unknown"}});
        }

        if (value.is_string()) {
            return sanitize(value.get<std::string>(), 2048);
        }

        if (value.is_number() || value.is_boolean() || value.is_null()) {
            return value;
        }

        if (value.is_array()) {
            json out = json::array();
            const std::size_t n = value.size();
            const std::size_t take = std::min<std::size_t>(n, static_cast<std::size_t>(std::max(0, maxItems)));
            for (std::size_t i = 0; i < take; ++i) {
                out.push_back(summarizeJson(value[i], depth - 1, maxItems));
            }
            if (n > take) {
                out.push_back(json::object({{"more", static_cast<int>(n - take)}}));
            }
            return json::object({{"type", "array"}, {"size", n}, {"items", out}});
        }

        if (value.is_object()) {
            json out = json::object();
            int count = 0;
            for (auto it = value.begin(); it != value.end(); ++it) {
                if (count >= maxItems) break;
                out[sanitize(it.key(), 96)] = summarizeJson(it.value(), depth - 1, maxItems);
                ++count;
            }
            if (static_cast<int>(value.size()) > maxItems) {
                out["__moreKeys"] = static_cast<int>(value.size()) - maxItems;
            }
            return out;
        }

        return json::object({{"type", "unknown"}});
    }

private:
    static std::string isoNow() {
        const auto now = std::chrono::system_clock::now();
        const std::time_t t = std::chrono::system_clock::to_time_t(now);
        std::tm tm{};
#ifdef _WIN32
        localtime_s(&tm, &t);
#else
        localtime_r(&t, &tm);
#endif
        std::ostringstream oss;
        oss << std::put_time(&tm, "%Y-%m-%dT%H:%M:%S");
        return oss.str();
    }

    static std::string sanitize(const std::string &s, std::size_t maxLen) {
        std::string out;
        out.reserve(std::min<std::size_t>(s.size(), maxLen));
        for (char c : s) {
            if (out.size() >= maxLen) break;
            if (c == '\n') {
                out += "\\n";
            } else if (c == '\r') {
                out += "\\r";
            } else if (c == '\t') {
                out += "\\t";
            } else if (static_cast<unsigned char>(c) < 0x20) {
                out.push_back(' ');
            } else {
                out.push_back(c);
            }
        }
        return out;
    }

    void rotateIfNeededLocked() {
        try {
            if (!fs::exists(logFile_)) return;
            const std::uintmax_t size = fs::file_size(logFile_);
            if (size < 5u * 1024u * 1024u) return;

            const std::string rotated = logFile_.string() + "." + isoNow();
            fs::rename(logFile_, fs::path(rotated));
        } catch (...) {
        }
    }

    fs::path logFile_;
    std::mutex mutex_;
};

static std::string base64Encode(const std::string &input) {
    static constexpr char kTable[] =
        "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    std::string out;
    out.reserve(((input.size() + 2) / 3) * 4);

    std::uint32_t val = 0;
    int valb = -6;
    for (unsigned char c : input) {
        val = (val << 8) + c;
        valb += 8;
        while (valb >= 0) {
            out.push_back(kTable[(val >> valb) & 0x3F]);
            valb -= 6;
        }
    }
    if (valb > -6) out.push_back(kTable[((val << 8) >> (valb + 8)) & 0x3F]);
    while (out.size() % 4) out.push_back('=');
    return out;
}

static std::string urlEncode(const std::string &input) {
    static const char *hex = "0123456789ABCDEF";
    std::string out;
    out.reserve(input.size() * 3);
    for (unsigned char c : input) {
        if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') ||
            (c >= '0' && c <= '9') || c == '-' || c == '_' || c == '.' || c == '~' || c == '/') {
            out.push_back(static_cast<char>(c));
        } else {
            out.push_back('%');
            out.push_back(hex[(c >> 4) & 0xF]);
            out.push_back(hex[c & 0xF]);
        }
    }
    return out;
}

class ConfigStore {
public:
    explicit ConfigStore(Paths paths) : paths_(std::move(paths)) {
        kv_ = loadJsonObject(paths_.kvConfigFile);
        structured_ = loadJsonObject(paths_.structuredConfigFile);
    }

    json getAll(const std::string &ns) {
        std::lock_guard<std::mutex> lock(mutex_);
        if (ns.empty()) return kv_;
        json out = json::object();
        for (auto it = kv_.begin(); it != kv_.end(); ++it) {
            if (it.key().rfind(ns, 0) == 0) {
                out[it.key()] = it.value();
            }
        }
        return out;
    }

    std::optional<json> get(const std::string &key) {
        std::lock_guard<std::mutex> lock(mutex_);
        auto it = kv_.find(key);
        if (it == kv_.end()) return std::nullopt;
        return *it;
    }

    void set(const std::string &key, const json &value) {
        std::lock_guard<std::mutex> lock(mutex_);
        kv_[key] = value;
        persistLocked();
    }

    void remove(const std::string &key) {
        std::lock_guard<std::mutex> lock(mutex_);
        kv_.erase(key);
        persistLocked();
    }

    void writeStructured(const std::string &key, const json &value) {
        std::lock_guard<std::mutex> lock(mutex_);
        structured_[key] = value;
        persistLocked();
    }

private:
    static json loadJsonObject(const fs::path &path) {
        if (!fs::exists(path)) return json::object();
        std::ifstream in(path);
        if (!in) return json::object();
        try {
            json value;
            in >> value;
            if (!value.is_object()) return json::object();
            return value;
        } catch (...) {
            return json::object();
        }
    }

    void persistLocked() {
        std::ofstream kvOut(paths_.kvConfigFile);
        kvOut << kv_.dump(2);
        kvOut.close();

        std::ofstream structuredOut(paths_.structuredConfigFile);
        structuredOut << structured_.dump(2);
        structuredOut.close();
    }

    Paths paths_;
    json kv_;
    json structured_;
    std::mutex mutex_;
};

class FsService {
public:
    explicit FsService(Paths paths)
        : paths_(std::move(paths)),
          realRoot_(fs::path(getHomePath())),
          watcherRunning_(false) {
        cachedSnapshot_ = loadCachedSnapshot();
    }

    ~FsService() {
        stopWatcher();
    }

    json getRootInfo() const {
        const fs::path real = getRealRootCopy();

        auto tildeify = [this](const fs::path &p) {
            const std::string full = p.string();
            const std::string home = paths_.home.string();
            if (home.empty()) return full;
            if (full == home) return std::string("~");
            if (full.rfind(home + "/", 0) == 0) {
                return std::string("~/") + full.substr(home.size() + 1);
            }
            return full;
        };

        const std::string display = tildeify(real);
        return json::object({
            {"ok", true},
            {"virtualRoot", "/Home"},
            {"realRoot", real.string()},
            {"realRootDisplay", display},
            {"realRootStored", display}
        });
    }

    json setRoot(const json &payload) {
        std::string raw = payload.value("realRoot", std::string());
        auto trimInPlace = [](std::string &s) {
            const auto notSpace = [](unsigned char c) { return !std::isspace(c); };
            s.erase(s.begin(), std::find_if(s.begin(), s.end(), notSpace));
            s.erase(std::find_if(s.rbegin(), s.rend(), notSpace).base(), s.end());
        };
        trimInPlace(raw);
        if (raw.empty()) {
            return json::object({{"ok", false}, {"error", json::object({{"code", "EINVAL"}, {"message", "Missing realRoot"}})}});
        }

        if (raw == "default") {
            raw = "~";
        }

        fs::path requested;
        if (raw == "~") {
            requested = fs::path(getHomePath());
        } else if (raw.rfind("~/", 0) == 0) {
            requested = fs::path(getHomePath()) / fs::path(raw.substr(2));
        } else {
            requested = fs::path(raw);
        }

        if (!requested.is_absolute()) {
            requested = getRealRootCopy() / requested;
        }

        std::error_code ec;
        fs::path canon = fs::weakly_canonical(requested, ec);
        if (ec) {
            canon = requested.lexically_normal();
        }

        ec.clear();
        if (!fs::exists(canon, ec) || ec) {
            return json::object({{"ok", false}, {"error", json::object({{"code", "ENOENT"}, {"message", "Root path not found"}})}});
        }
        if (!fs::is_directory(canon, ec) || ec) {
            return json::object({{"ok", false}, {"error", json::object({{"code", "ENOTDIR"}, {"message", "Root is not a directory"}})}});
        }

        {
            std::lock_guard<std::mutex> lock(rootMutex_);
            realRoot_ = canon;
        }

        invalidateDirCache();
        {
            std::lock_guard<std::mutex> lock(mutex_);
            cachedSnapshot_ = json::object();
        }

        const json info = getRootInfo();
        notifyChanged("rootChanged", json::object({
            {"virtualRoot", info.value("virtualRoot", std::string("/Home"))},
            {"realRoot", info.value("realRoot", canon.string())},
            {"realRootDisplay", info.value("realRootDisplay", std::string())},
            {"realRootStored", info.value("realRootStored", std::string())}
        }));
        return info;
    }

    json snapshot() {
        std::lock_guard<std::mutex> lock(mutex_);
        if (!cachedSnapshot_.is_object() || cachedSnapshot_.empty()) {
            const fs::path root = getRealRootCopy();
            cachedSnapshot_ = buildSnapshot(root, 8, 5000);
            persistSnapshot(cachedSnapshot_);
        }
        return cachedSnapshot_;
    }

    void seed(const json &snapshot) {
        if (!snapshot.is_object()) return;
        {
            std::lock_guard<std::mutex> lock(mutex_);
            cachedSnapshot_ = snapshot;
            persistSnapshot(cachedSnapshot_);
        }
    }

    json listDir(const json &payload) {
        const std::string virtPath = payload.value("path", std::string("/Home"));
        const bool showHidden = payload.value("showHidden", false);
        const std::string cursor = payload.value("cursor", std::string());

        int limit = 400;
        try {
            limit = payload.value("limit", limit);
        } catch (...) {
            limit = 400;
        }
        if (limit < 1) limit = 1;
        if (limit > 2000) limit = 2000;

        int offset = 0;
        if (!cursor.empty()) {
            try {
                offset = std::stoi(cursor);
            } catch (...) {
                offset = 0;
            }
        }
        if (offset < 0) offset = 0;

        const auto real = toRealPath(virtPath);
        if (!real.has_value()) {
            return json::object({
                {"ok", false},
                {"path", virtPath},
                {"error", json::object({{"code", "EINVAL"}, {"message", "Invalid path"}})}
            });
        }

        std::error_code ec;
        if (!fs::exists(*real, ec) || ec) {
            return json::object({
                {"ok", false},
                {"path", virtPath},
                {"error", json::object({{"code", "ENOENT"}, {"message", "Path not found"}})}
            });
        }
        if (!fs::is_directory(*real, ec) || ec) {
            return json::object({
                {"ok", false},
                {"path", virtPath},
                {"error", json::object({{"code", "ENOTDIR"}, {"message", "Not a directory"}})}
            });
        }

        const std::string cacheKey = virtPath + std::string("|h=") + (showHidden ? "1" : "0");
        DirCacheEntry cached;
        bool hasCached = false;
        {
            std::lock_guard<std::mutex> lock(dirCacheMutex_);
            auto it = dirCache_.find(cacheKey);
            if (it != dirCache_.end()) {
                const auto age = std::chrono::steady_clock::now() - it->second.builtAt;
                if (age < std::chrono::milliseconds(1500)) {
                    cached = it->second;
                    hasCached = true;
                }
            }
        }

        if (!hasCached) {
            cached.entries.clear();
            cached.skippedErrors = 0;
            cached.builtAt = std::chrono::steady_clock::now();

            fs::directory_iterator it(*real, fs::directory_options::none, ec);
            if (ec) {
                const std::string code = (ec == std::errc::permission_denied) ? "EACCES" : "EIO";
                return json::object({
                    {"ok", false},
                    {"path", virtPath},
                    {"error", json::object({{"code", code}, {"message", ec.message()}})}
                });
            }

            for (; it != fs::directory_iterator(); it.increment(ec)) {
                if (ec) {
                    cached.skippedErrors += 1;
                    ec.clear();
                    continue;
                }

                const fs::directory_entry &entry = *it;
                const std::string name = entry.path().filename().string();
                if (!showHidden && !name.empty() && name[0] == '.') {
                    continue;
                }
                cached.entries.push_back(makeEntryForListing(entry));
            }

            std::sort(cached.entries.begin(), cached.entries.end(), [](const json &a, const json &b) {
                const std::string at = a.value("type", std::string("file"));
                const std::string bt = b.value("type", std::string("file"));
                const bool ad = (at == "folder");
                const bool bd = (bt == "folder");
                if (ad != bd) return ad > bd;
                const std::string an = a.value("name", std::string());
                const std::string bn = b.value("name", std::string());
                return an < bn;
            });

            {
                std::lock_guard<std::mutex> lock(dirCacheMutex_);
                dirCache_[cacheKey] = cached;
            }
        }

        const int total = static_cast<int>(cached.entries.size());
        if (offset > total) offset = total;
        const int end = std::min(total, offset + limit);

        json slice = json::array();
        for (int i = offset; i < end; ++i) {
            slice.push_back(cached.entries[static_cast<std::size_t>(i)]);
        }

        json out = json::object({
            {"ok", true},
            {"path", virtPath},
            {"entries", slice},
            {"total", total},
            {"offset", offset},
            {"limit", limit},
            {"hasMore", end < total},
            {"nextCursor", end < total ? json(std::to_string(end)) : json(nullptr)},
            {"skippedErrors", cached.skippedErrors}
        });

        return out;
    }

    json mkdirIntent(const json &payload) {
        const auto started = std::chrono::steady_clock::now();
        const std::string parentVirt = payload.value("path", std::string("/Home"));
        const std::string name = payload.value("name", std::string());
        const std::string policyRaw = payload.value("conflictPolicy", std::string("keep-both"));

        if (name.find('/') != std::string::npos || name.find('\\') != std::string::npos) {
            return json::object({{"ok", false}, {"error", json::object({{"code", "EINVAL"}, {"message", "Invalid folder name"}})}});
        }

        const std::string targetVirt = name.empty() ? parentVirt : (parentVirt + "/" + name);
        const auto real = toRealPath(targetVirt);
        if (!real.has_value()) {
            return json::object({{"ok", false}, {"error", json::object({{"code", "EINVAL"}, {"message", "Invalid path"}})}});
        }

        std::error_code ec;
        if (fs::exists(*real, ec) && !ec) {
            if (policyRaw == "skip") {
                return json::object({{"ok", true}, {"applied", json::array()}, {"skipped", json::array({json::object({{"path", targetVirt}, {"reason", "exists"}})})}});
            }
            if (policyRaw == "keep-both" && !name.empty()) {
                const auto parentReal = toRealPath(parentVirt);
                if (parentReal.has_value()) {
                    const fs::path unique = uniqueChildPath(*parentReal, name);
                    const std::string uniqueVirt = parentVirt + "/" + unique.filename().string();
                    std::error_code mkEc;
                    fs::create_directory(unique, mkEc);
                    if (mkEc) {
                        return json::object({{"ok", false}, {"error", json::object({{"code", "EIO"}, {"message", mkEc.message()}})}});
                    }
                    invalidateDirCache();
                    notifyChanged("mkdir", json::object());
                    return finalizeOpResult("mkdir", started, json::array({json::object({{"kind", "mkdir"}, {"path", uniqueVirt}})}));
                }
            }
            // overwrite means ok if already exists
            return finalizeOpResult("mkdir", started, json::array(), json::array({json::object({{"path", targetVirt}, {"reason", "exists"}})}));
        }

        fs::create_directories(*real, ec);
        if (ec) {
            const std::string code = (ec == std::errc::permission_denied) ? "EACCES" : "EIO";
            return json::object({{"ok", false}, {"error", json::object({{"code", code}, {"message", ec.message()}})}});
        }

        invalidateDirCache();
        notifyChanged("mkdir", json::object());
        return finalizeOpResult("mkdir", started, json::array({json::object({{"kind", "mkdir"}, {"path", targetVirt}})}));
    }

    json createFileIntent(const json &payload) {
        const auto started = std::chrono::steady_clock::now();
        const std::string parentVirt = payload.value("path", std::string("/Home"));
        const std::string name = payload.value("name", std::string());
        const std::string policyRaw = payload.value("conflictPolicy", std::string("keep-both"));

        if (name.empty() || name.find('/') != std::string::npos || name.find('\\') != std::string::npos) {
            return json::object({{"ok", false}, {"error", json::object({{"code", "EINVAL"}, {"message", "Invalid file name"}})}});
        }

        const auto parentReal = toRealPath(parentVirt);
        if (!parentReal.has_value()) {
            return json::object({{"ok", false}, {"error", json::object({{"code", "EINVAL"}, {"message", "Invalid path"}})}});
        }

        std::error_code ec;
        fs::create_directories(*parentReal, ec);
        if (ec) {
            const std::string code = (ec == std::errc::permission_denied) ? "EACCES" : "EIO";
            return json::object({{"ok", false}, {"error", json::object({{"code", code}, {"message", ec.message()}})}});
        }

        fs::path dest = (*parentReal) / fs::path(name);
        if (fs::exists(dest, ec) && !ec) {
            if (policyRaw == "skip") {
                return json::object({{"ok", true}, {"applied", json::array()}, {"skipped", json::array({json::object({{"path", parentVirt + "/" + name}, {"reason", "exists"}})})}});
            }
            if (policyRaw == "keep-both") {
                dest = uniqueChildPath(*parentReal, name);
            }
        }

        errno = 0;
        std::ofstream out(dest, std::ios::binary | std::ios::out | std::ios::trunc);
        if (!out) {
            const int e = errno;
            const std::string code = (e == EACCES || e == EPERM) ? "EACCES" : "EIO";
            const std::string msg = (e != 0) ? std::strerror(e) : std::string("Failed to create file");
            return json::object({{"ok", false}, {"error", json::object({{"code", code}, {"message", msg}})}});
        }
        out.close();

        invalidateDirCache();
        notifyChanged("createFile", json::object());
        const std::string virtCreated = parentVirt + "/" + dest.filename().string();
        return finalizeOpResult("createFile", started, json::array({json::object({{"kind", "createFile"}, {"path", virtCreated}})}));
    }

    json renameIntent(const json &payload) {
        const auto started = std::chrono::steady_clock::now();
        const std::string srcVirt = payload.value("path", std::string());
        const std::string newName = payload.value("newName", std::string());
        const std::string policyRaw = payload.value("conflictPolicy", std::string("keep-both"));

        if (srcVirt.empty() || newName.empty() || newName.find('/') != std::string::npos || newName.find('\\') != std::string::npos) {
            return json::object({{"ok", false}, {"error", json::object({{"code", "EINVAL"}, {"message", "Invalid rename"}})}});
        }

        const auto srcReal = toRealPath(srcVirt);
        if (!srcReal.has_value()) {
            return json::object({{"ok", false}, {"error", json::object({{"code", "EINVAL"}, {"message", "Invalid path"}})}});
        }

        fs::path parent = srcReal->parent_path();
        fs::path dest = parent / fs::path(newName);

        std::error_code ec;
        if (fs::exists(dest, ec) && !ec) {
            if (policyRaw == "skip") {
                return json::object({{"ok", true}, {"applied", json::array()}, {"skipped", json::array({json::object({{"path", srcVirt}, {"reason", "destination-exists"}})})}});
            }
            if (policyRaw == "keep-both") {
                dest = uniqueChildPath(parent, newName);
            }
            if (policyRaw == "overwrite") {
                fs::remove_all(dest, ec);
                ec.clear();
            }
        }

        fs::rename(*srcReal, dest, ec);
        if (ec) {
            const std::string code = (ec == std::errc::permission_denied) ? "EACCES" : "EIO";
            return json::object({{"ok", false}, {"error", json::object({{"code", code}, {"message", ec.message()}})}});
        }

        invalidateDirCache();
        notifyChanged("rename", json::object());
        const std::string destVirt = parentVirtFromChild(srcVirt) + "/" + dest.filename().string();
        return finalizeOpResult("rename", started, json::array({json::object({{"kind", "rename"}, {"from", srcVirt}, {"to", destVirt}})}));
    }

    json deleteIntent(const json &payload) {
        const auto started = std::chrono::steady_clock::now();
        json paths = payload.value("paths", json::array());
        if (!paths.is_array()) paths = json::array();

        json applied = json::array();
        json errors = json::array();

        for (const auto &p : paths) {
            if (!p.is_string()) continue;
            const std::string virt = p.get<std::string>();
            const auto real = toRealPath(virt);
            if (!real.has_value()) {
                errors.push_back(json::object({{"path", virt}, {"code", "EINVAL"}, {"message", "Invalid path"}}));
                continue;
            }

            std::error_code ec;
            const std::uintmax_t removed = fs::remove_all(*real, ec);
            if (ec) {
                const std::string code = (ec == std::errc::permission_denied) ? "EACCES" : "EIO";
                errors.push_back(json::object({{"path", virt}, {"code", code}, {"message", ec.message()}}));
                continue;
            }
            (void)removed;
            applied.push_back(json::object({{"kind", "delete"}, {"path", virt}}));
        }

        invalidateDirCache();
        notifyChanged("delete", json::object());
        return finalizeOpResult("delete", started, applied, json::array(), json::array(), errors);
    }

    json copyIntent(const json &payload) {
        return transferIntent("copy", payload);
    }

    json moveIntent(const json &payload) {
        return transferIntent("move", payload);
    }

    json termExec(const json &payload) {
#ifdef MMM_PLATFORM_LINUX
        const auto started = std::chrono::steady_clock::now();
        const std::string cwdVirt = payload.value("cwd", std::string("/Home"));
        const std::string command = payload.value("command", std::string());

        if (command.empty()) {
            return json::object({{"ok", false}, {"error", json::object({{"code", "EINVAL"}, {"message", "Missing command"}})}});
        }
        if (command.size() > 8192) {
            return json::object({{"ok", false}, {"error", json::object({{"code", "EINVAL"}, {"message", "Command too long"}})}});
        }

        int timeoutMs = 20000;
        try {
            timeoutMs = payload.value("timeoutMs", timeoutMs);
        } catch (...) {
            timeoutMs = 20000;
        }
        if (timeoutMs < 100) timeoutMs = 100;
        if (timeoutMs > 600000) timeoutMs = 600000;

        int maxOutputKb = 512;
        try {
            maxOutputKb = payload.value("maxOutputKb", maxOutputKb);
        } catch (...) {
            maxOutputKb = 512;
        }
        if (maxOutputKb < 8) maxOutputKb = 8;
        if (maxOutputKb > 4096) maxOutputKb = 4096;
        const std::size_t maxOutputBytes = static_cast<std::size_t>(maxOutputKb) * 1024ull;

        const auto cwdRealOpt = toRealPath(cwdVirt);
        if (!cwdRealOpt.has_value()) {
            return json::object({{"ok", false}, {"error", json::object({{"code", "EINVAL"}, {"message", "Invalid cwd"}})}});
        }

        std::error_code ec;
        if (!fs::exists(*cwdRealOpt, ec) || ec || !fs::is_directory(*cwdRealOpt, ec) || ec) {
            return json::object({{"ok", false}, {"error", json::object({{"code", "ENOTDIR"}, {"message", "cwd is not a directory"}})}});
        }

        int outPipe[2] = {-1, -1};
        int errPipe[2] = {-1, -1};
        if (pipe(outPipe) != 0 || pipe(errPipe) != 0) {
            const std::string msg = std::strerror(errno);
            if (outPipe[0] != -1) close(outPipe[0]);
            if (outPipe[1] != -1) close(outPipe[1]);
            if (errPipe[0] != -1) close(errPipe[0]);
            if (errPipe[1] != -1) close(errPipe[1]);
            return json::object({{"ok", false}, {"error", json::object({{"code", "EIO"}, {"message", msg}})}});
        }

        auto setNonBlocking = [](int fd) {
            const int flags = fcntl(fd, F_GETFL, 0);
            if (flags >= 0) {
                fcntl(fd, F_SETFL, flags | O_NONBLOCK);
            }
        };

        setNonBlocking(outPipe[0]);
        setNonBlocking(errPipe[0]);

        const fs::path cwdReal = *cwdRealOpt;
        const std::string cmdCopy = command;

        pid_t pid = fork();
        if (pid == 0) {
            (void)chdir(cwdReal.c_str());
            (void)dup2(outPipe[1], STDOUT_FILENO);
            (void)dup2(errPipe[1], STDERR_FILENO);
            close(outPipe[0]);
            close(outPipe[1]);
            close(errPipe[0]);
            close(errPipe[1]);

            const char *cmd = cmdCopy.c_str();
            execl("/bin/bash", "bash", "-lc", cmd, (char *)nullptr);
            execl("/usr/bin/bash", "bash", "-lc", cmd, (char *)nullptr);
            execl("/bin/sh", "sh", "-lc", cmd, (char *)nullptr);
            _exit(127);
        }

        if (pid < 0) {
            const std::string msg = std::strerror(errno);
            close(outPipe[0]);
            close(outPipe[1]);
            close(errPipe[0]);
            close(errPipe[1]);
            return json::object({{"ok", false}, {"error", json::object({{"code", "EIO"}, {"message", msg}})}});
        }

        close(outPipe[1]);
        close(errPipe[1]);

        bool timedOut = false;
        bool stdoutOpen = true;
        bool stderrOpen = true;
        bool outTruncated = false;
        bool errTruncated = false;

        std::string stdoutBuf;
        std::string stderrBuf;
        stdoutBuf.reserve(std::min<std::size_t>(maxOutputBytes, 64 * 1024));
        stderrBuf.reserve(std::min<std::size_t>(maxOutputBytes, 64 * 1024));

        int status = 0;
        bool exited = false;

        auto drainFd = [&](int fd, std::string &buf, bool &truncFlag) -> bool {
            char tmp[4096];
            for (;;) {
                const ssize_t n = read(fd, tmp, sizeof(tmp));
                if (n > 0) {
                    if (buf.size() < maxOutputBytes) {
                        const std::size_t take = std::min<std::size_t>(static_cast<std::size_t>(n), maxOutputBytes - buf.size());
                        buf.append(tmp, tmp + take);
                        if (take < static_cast<std::size_t>(n)) {
                            truncFlag = true;
                        }
                    } else {
                        truncFlag = true;
                    }
                    continue;
                }
                if (n == 0) {
                    return false;
                }
                if (errno == EAGAIN || errno == EWOULDBLOCK) {
                    return true;
                }
                return false;
            }
        };

        auto deadline = std::chrono::steady_clock::now() + std::chrono::milliseconds(timeoutMs);

        while (stdoutOpen || stderrOpen || !exited) {
            const auto now = std::chrono::steady_clock::now();
            if (!timedOut && now >= deadline) {
                timedOut = true;
                kill(pid, SIGKILL);
            }

            int waitStatus = 0;
            const pid_t w = waitpid(pid, &waitStatus, WNOHANG);
            if (w == pid) {
                status = waitStatus;
                exited = true;
            }

            struct pollfd fds[2];
            nfds_t nfds = 0;
            if (stdoutOpen) {
                fds[nfds].fd = outPipe[0];
                fds[nfds].events = POLLIN;
                fds[nfds].revents = 0;
                nfds += 1;
            }
            if (stderrOpen) {
                fds[nfds].fd = errPipe[0];
                fds[nfds].events = POLLIN;
                fds[nfds].revents = 0;
                nfds += 1;
            }

            int pollTimeout = 50;
            if (timedOut) pollTimeout = 0;

            if (nfds > 0) {
                (void)poll(fds, nfds, pollTimeout);
            }

            if (stdoutOpen) {
                stdoutOpen = drainFd(outPipe[0], stdoutBuf, outTruncated);
            }
            if (stderrOpen) {
                stderrOpen = drainFd(errPipe[0], stderrBuf, errTruncated);
            }

            if (exited && !stdoutOpen && !stderrOpen) {
                break;
            }
        }

        close(outPipe[0]);
        close(errPipe[0]);

        if (!exited) {
            (void)waitpid(pid, &status, 0);
            exited = true;
        }

        int exitCode = 0;
        int termSignal = 0;
        if (WIFEXITED(status)) {
            exitCode = WEXITSTATUS(status);
        } else if (WIFSIGNALED(status)) {
            termSignal = WTERMSIG(status);
            exitCode = 128 + termSignal;
        }

        invalidateDirCache();
        notifyChanged("term.exec", json::object({{"cwd", cwdVirt}}));

        const auto ended = std::chrono::steady_clock::now();
        const auto durMs = std::chrono::duration_cast<std::chrono::milliseconds>(ended - started).count();

        return json::object({
            {"ok", true},
            {"cwd", cwdVirt},
            {"exitCode", exitCode},
            {"signal", termSignal ? json(termSignal) : json(nullptr)},
            {"timedOut", timedOut},
            {"stdout", stdoutBuf},
            {"stderr", stderrBuf},
            {"truncated", json::object({{"stdout", outTruncated}, {"stderr", errTruncated}})},
            {"durationMs", durMs}
        });
#else
        (void)payload;
        return json::object({{"ok", false}, {"error", json::object({{"code", "ENOSYS"}, {"message", "Terminal exec not supported"}})}});
#endif
    }

    json applyOperation(const json &op) {
        // Current JS runtime already applies local mutations and sends a new snapshot.
        // Persist quickly in native state and trigger update event for listeners.
        const json operation = op.value("operation", json::object());
        const json snapshot = operation.value("snapshot", json::object());
        if (snapshot.is_object() && !snapshot.empty()) {
            {
                std::lock_guard<std::mutex> lock(mutex_);
                cachedSnapshot_ = snapshot;
                persistSnapshot(cachedSnapshot_);
            }
            notifyChanged("operation-commit", snapshot);
        }

        json result = {
            {"ok", true},
            {"appliedAt", isoNow()},
            {"label", operation.value("label", std::string("operation"))}
        };
        return result;
    }

    void setOnChange(std::function<void(const json &)> cb) {
        onChange_ = std::move(cb);
    }

    void startWatcher() {
        if (watcherRunning_.exchange(true)) return;
        watcher_ = std::thread([this]() {
            while (watcherRunning_.load()) {
                try {
                    const fs::path root = getRealRootCopy();
                    json next = buildSnapshot(root, 8, 5000);
                    bool changed = false;
                    {
                        std::lock_guard<std::mutex> lock(mutex_);
                        if (next.dump() != cachedSnapshot_.dump()) {
                            cachedSnapshot_ = next;
                            persistSnapshot(cachedSnapshot_);
                            changed = true;
                        }
                    }
                    if (changed) {
                        notifyChanged("watcher", next);
                    }
                } catch (...) {
                    // Keep watcher alive on transient filesystem errors.
                }
                std::this_thread::sleep_for(std::chrono::seconds(3));
            }
        });
    }

    void stopWatcher() {
        watcherRunning_.store(false);
        if (watcher_.joinable()) {
            watcher_.join();
        }
    }

private:
    static std::string isoNow() {
        const auto now = std::chrono::system_clock::now();
        const std::time_t t = std::chrono::system_clock::to_time_t(now);
        std::tm tm{};
#ifdef _WIN32
        localtime_s(&tm, &t);
#else
        localtime_r(&t, &tm);
#endif
        std::ostringstream oss;
        oss << std::put_time(&tm, "%Y-%m-%dT%H:%M:%S");
        return oss.str();
    }

    static std::string formatDate(const fs::file_time_type &fileTime) {
        const auto systemNow = std::chrono::system_clock::now();
        const auto fsNow = fs::file_time_type::clock::now();
        const auto converted = std::chrono::time_point_cast<std::chrono::system_clock::duration>(
            fileTime - fsNow + systemNow);
        const std::time_t t = std::chrono::system_clock::to_time_t(converted);
        std::tm tm{};
#ifdef _WIN32
        localtime_s(&tm, &t);
#else
        localtime_r(&t, &tm);
#endif
        std::ostringstream oss;
        oss << std::put_time(&tm, "%Y-%m-%d");
        return oss.str();
    }

    static std::string extensionFor(const fs::path &p) {
        std::string ext = p.extension().string();
        if (!ext.empty() && ext.front() == '.') ext.erase(ext.begin());
        std::transform(ext.begin(), ext.end(), ext.begin(), [](unsigned char c) {
            return static_cast<char>(std::tolower(c));
        });
        return ext;
    }

    static bool isSubpath(const fs::path &root, const fs::path &path) {
        fs::path r = root.lexically_normal();
        fs::path p = path.lexically_normal();
        auto rit = r.begin();
        auto pit = p.begin();
        for (; rit != r.end(); ++rit, ++pit) {
            if (pit == p.end()) return false;
            if (*rit != *pit) return false;
        }
        return true;
    }

    static fs::path weaklyCanonicalOrNormalize(const fs::path &p) {
        std::error_code ec;
        fs::path canon = fs::weakly_canonical(p, ec);
        if (ec) {
            return p.lexically_normal();
        }
        return canon;
    }

    fs::path getRealRootCopy() const {
        std::lock_guard<std::mutex> lock(rootMutex_);
        return realRoot_;
    }

    std::optional<fs::path> toRealPath(const std::string &virtualPath) const {
        const fs::path root = getRealRootCopy();
        const fs::path rootCanon = weaklyCanonicalOrNormalize(root);

        if (virtualPath == "/Home" || virtualPath == "/Home/") return rootCanon;
        if (virtualPath.rfind("/Home/", 0) != 0) return std::nullopt;

        const auto rel = virtualPath.substr(std::string("/Home/").size());
        const fs::path targetLex = (root / fs::path(rel)).lexically_normal();
        const fs::path targetCanon = weaklyCanonicalOrNormalize(targetLex);
        if (!isSubpath(rootCanon, targetCanon)) return std::nullopt;
        return targetCanon;
    }

    void invalidateDirCache() {
        std::lock_guard<std::mutex> lock(dirCacheMutex_);
        dirCache_.clear();
    }

    static std::string parentVirtFromChild(const std::string &virtPath) {
        const std::size_t pos = virtPath.find_last_of('/');
        if (pos == std::string::npos || pos == 0) return std::string("/Home");
        if (pos <= std::string("/Home").size()) return std::string("/Home");
        return virtPath.substr(0, pos);
    }

    static fs::path uniqueChildPath(const fs::path &parentDir, const std::string &name) {
        fs::path initial = parentDir / fs::path(name);
        std::error_code ec;
        if (!fs::exists(initial, ec) || ec) {
            return initial;
        }

        const std::string original = fs::path(name).filename().string();
        const std::size_t dot = original.find_last_of('.');
        const bool hasExt = (dot != std::string::npos && dot != 0);
        const std::string base = hasExt ? original.substr(0, dot) : original;
        const std::string ext = hasExt ? original.substr(dot) : std::string();

        for (int i = 2; i < 10000; i += 1) {
            const std::string candidate = base + " (" + std::to_string(i) + ")" + ext;
            fs::path p = parentDir / fs::path(candidate);
            ec.clear();
            if (!fs::exists(p, ec) || ec) {
                return p;
            }
        }

        // Fallback if directory is extremely saturated.
        return parentDir / fs::path(base + " (copy)" + ext);
    }

    std::string nextOpId(const std::string &prefix) {
        const auto n = ++opCounter_;
        return prefix + "-" + std::to_string(static_cast<unsigned long long>(n));
    }

    json finalizeOpResult(const std::string &kind,
                          const std::chrono::steady_clock::time_point &started,
                          const json &applied,
                          const json &skipped = json::array(),
                          const json &conflicts = json::array(),
                          const json &errors = json::array()) {
        const auto ended = std::chrono::steady_clock::now();
        const auto durMs = std::chrono::duration_cast<std::chrono::milliseconds>(ended - started).count();
        json out = json::object({
            {"ok", errors.is_array() ? errors.empty() : true},
            {"opId", nextOpId(kind)},
            {"kind", kind},
            {"durationMs", durMs},
            {"applied", applied.is_array() ? applied : json::array()},
            {"skipped", skipped.is_array() ? skipped : json::array()},
            {"conflicts", conflicts.is_array() ? conflicts : json::array()},
            {"errors", errors.is_array() ? errors : json::array()}
        });
        return out;
    }

    json transferIntent(const std::string &mode, const json &payload) {
        const auto started = std::chrono::steady_clock::now();
        const std::string destVirt = payload.value("destDir", std::string("/Home"));
        const std::string policyRaw = payload.value("conflictPolicy", std::string("keep-both"));

        json sources = payload.value("sources", json::array());
        if (!sources.is_array()) sources = json::array();

        const auto destRealOpt = toRealPath(destVirt);
        if (!destRealOpt.has_value()) {
            return json::object({{"ok", false}, {"error", json::object({{"code", "EINVAL"}, {"message", "Invalid destination"}})}});
        }
        const fs::path destDirReal = destRealOpt.value();

        std::error_code ec;
        fs::create_directories(destDirReal, ec);
        if (ec) {
            const std::string code = (ec == std::errc::permission_denied) ? "EACCES" : "EIO";
            return json::object({{"ok", false}, {"error", json::object({{"code", code}, {"message", ec.message()}})}});
        }

        json applied = json::array();
        json skipped = json::array();
        json conflicts = json::array();
        json errors = json::array();

        auto doCopyRecursive = [](const fs::path &src, const fs::path &dst, std::error_code &copyEc) {
            copyEc.clear();
            std::error_code dirEc;
            const bool srcIsDir = fs::is_directory(src, dirEc) && !dirEc;
            if (!srcIsDir) {
                fs::copy_file(src, dst, fs::copy_options::overwrite_existing, copyEc);
                return;
            }

            fs::create_directories(dst, copyEc);
            if (copyEc) return;

            fs::copy(src,
                     dst,
                     fs::copy_options::recursive | fs::copy_options::copy_symlinks | fs::copy_options::overwrite_existing,
                     copyEc);
        };

        for (const auto &s : sources) {
            if (!s.is_string()) continue;
            const std::string srcVirt = s.get<std::string>();
            const auto srcRealOpt = toRealPath(srcVirt);
            if (!srcRealOpt.has_value()) {
                errors.push_back(json::object({{"path", srcVirt}, {"code", "EINVAL"}, {"message", "Invalid source"}}));
                continue;
            }
            const fs::path srcReal = srcRealOpt.value();

            ec.clear();
            if (!fs::exists(srcReal, ec) || ec) {
                errors.push_back(json::object({{"path", srcVirt}, {"code", "ENOENT"}, {"message", "Source missing"}}));
                continue;
            }

            const std::string baseName = srcReal.filename().string();
            fs::path destReal = destDirReal / fs::path(baseName);
            std::string destVirtFinal = destVirt + "/" + baseName;

            ec.clear();
            const bool destExists = fs::exists(destReal, ec) && !ec;
            if (destExists) {
                if (policyRaw == "skip") {
                    conflicts.push_back(json::object({{"from", srcVirt}, {"to", destVirtFinal}, {"reason", "exists"}}));
                    continue;
                }
                if (policyRaw == "keep-both") {
                    destReal = uniqueChildPath(destDirReal, baseName);
                    destVirtFinal = destVirt + "/" + destReal.filename().string();
                }
                if (policyRaw == "overwrite") {
                    fs::remove_all(destReal, ec);
                    ec.clear();
                }
            }

            std::error_code statEc;
            const bool srcIsDir = fs::is_directory(srcReal, statEc) && !statEc;
            if (srcIsDir) {
                // Block folder into itself.
                if (isSubpath(srcReal, destReal)) {
                    errors.push_back(json::object({{"path", srcVirt}, {"code", "EINVAL"}, {"message", "Cannot place a folder inside itself"}}));
                    continue;
                }
            }

            if (mode == "move") {
                fs::rename(srcReal, destReal, ec);
                if (ec) {
                    const bool isCrossDevice = (ec == std::errc::cross_device_link);
                    if (isCrossDevice) {
                        ec.clear();
                        doCopyRecursive(srcReal, destReal, ec);
                        if (ec) {
                            errors.push_back(json::object({{"from", srcVirt}, {"to", destVirtFinal}, {"code", "EIO"}, {"message", ec.message()}}));
                            continue;
                        }
                        // Basic integrity for files.
                        if (!srcIsDir) {
                            std::error_code aec;
                            const auto a = fs::file_size(srcReal, aec);
                            const auto b = fs::file_size(destReal, aec);
                            if (aec || a != b) {
                                errors.push_back(json::object({{"from", srcVirt}, {"to", destVirtFinal}, {"code", "EIO"}, {"message", "Size verification failed"}}));
                                continue;
                            }
                        }
                        fs::remove_all(srcReal, ec);
                        if (ec) {
                            errors.push_back(json::object({{"path", srcVirt}, {"code", "EIO"}, {"message", "Copied but failed to remove source"}}));
                            continue;
                        }
                    } else {
                        const std::string code = (ec == std::errc::permission_denied) ? "EACCES" : "EIO";
                        errors.push_back(json::object({{"from", srcVirt}, {"to", destVirtFinal}, {"code", code}, {"message", ec.message()}}));
                        continue;
                    }
                }
                applied.push_back(json::object({{"kind", "move"}, {"from", srcVirt}, {"to", destVirtFinal}}));
                continue;
            }

            // copy
            ec.clear();
            doCopyRecursive(srcReal, destReal, ec);
            if (ec) {
                const std::string code = (ec == std::errc::permission_denied) ? "EACCES" : "EIO";
                errors.push_back(json::object({{"from", srcVirt}, {"to", destVirtFinal}, {"code", code}, {"message", ec.message()}}));
                continue;
            }

            if (!srcIsDir) {
                std::error_code aec;
                const auto a = fs::file_size(srcReal, aec);
                const auto b = fs::file_size(destReal, aec);
                if (aec || a != b) {
                    errors.push_back(json::object({{"from", srcVirt}, {"to", destVirtFinal}, {"code", "EIO"}, {"message", "Size verification failed"}}));
                    continue;
                }
            }

            applied.push_back(json::object({{"kind", "copy"}, {"from", srcVirt}, {"to", destVirtFinal}}));
        }

        invalidateDirCache();
        notifyChanged(mode, json::object());
        return finalizeOpResult(mode, started, applied, skipped, conflicts, errors);
    }

    static void copyRecursive(const fs::path &src, const fs::path &dst, std::error_code &ec) {
        ec.clear();
        const bool srcIsDir = fs::is_directory(src, ec) && !ec;
        ec.clear();

        if (!srcIsDir) {
            fs::copy_file(src, dst, fs::copy_options::overwrite_existing, ec);
            return;
        }

        fs::create_directories(dst, ec);
        if (ec) return;

        fs::copy(src,
                 dst,
                 fs::copy_options::recursive | fs::copy_options::copy_symlinks | fs::copy_options::overwrite_existing,
                 ec);
    }

    static std::string formatSizeBytes(std::uintmax_t bytes) {
        if (bytes < 1024) return std::to_string(bytes) + " B";
        if (bytes < (1024 * 1024)) return std::to_string(bytes / 1024) + " KB";
        if (bytes < (1024ull * 1024ull * 1024ull)) return std::to_string(bytes / (1024 * 1024)) + " MB";
        return std::to_string(bytes / (1024ull * 1024ull * 1024ull)) + " GB";
    }

    json makeEntryForListing(const fs::directory_entry &entry) {
        json out = json::object();
        out["name"] = entry.path().filename().string();
        out["git"] = "untracked";

        std::error_code ec;
        const fs::file_status sy = entry.symlink_status(ec);
        const bool isSymlink = (!ec && sy.type() == fs::file_type::symlink);
        out["isSymlink"] = isSymlink;

        bool isDir = false;
        if (!ec) {
            if (isSymlink) {
                std::error_code ec2;
                const fs::file_status st = fs::status(entry.path(), ec2);
                if (!ec2) {
                    isDir = fs::is_directory(st);
                }
            } else {
                isDir = fs::is_directory(sy);
            }
        }

        out["type"] = isDir ? "folder" : "file";

        std::error_code timeEc;
        const auto t = entry.last_write_time(timeEc);
        out["modified"] = timeEc ? std::string("--") : formatDate(t);

        if (isDir) {
            out["size"] = "--";
        } else {
            std::error_code sizeEc;
            const std::uintmax_t bytes = entry.file_size(sizeEc);
            out["size"] = sizeEc ? std::string("0 B") : formatSizeBytes(bytes);
            out["ext"] = extensionFor(entry.path());
        }

        if (isSymlink) {
            std::error_code linkEc;
            const fs::path target = fs::read_symlink(entry.path(), linkEc);
            if (!linkEc) {
                out["symlinkTarget"] = target.string();
            }
        }

        return out;
    }

    json makeEntry(const fs::directory_entry &entry) {
        json out = json::object();
        const bool isDir = entry.is_directory();
        out["name"] = entry.path().filename().string();
        out["type"] = isDir ? "folder" : "file";
        out["modified"] = formatDate(entry.last_write_time());
        out["git"] = "untracked";
        if (isDir) {
            out["size"] = "--";
        } else {
            std::uintmax_t bytes = 0;
            std::error_code ec;
            bytes = entry.file_size(ec);
            if (ec) {
                out["size"] = "0 B";
            } else if (bytes < 1024) {
                out["size"] = std::to_string(bytes) + " B";
            } else if (bytes < (1024 * 1024)) {
                out["size"] = std::to_string(bytes / 1024) + " KB";
            } else {
                out["size"] = std::to_string(bytes / (1024 * 1024)) + " MB";
            }
            out["ext"] = extensionFor(entry.path());
        }
        return out;
    }

    json buildSnapshot(const fs::path &rootReal, int maxDepth, int maxEntriesPerDir) {
        json snapshot = json::object();
        snapshot["/Home"] = json::array();
        snapshot["/Home/Recycle Bin"] = json::array();

        struct Node {
            std::string virt;
            fs::path real;
            int depth;
        };

        std::queue<Node> q;
        q.push(Node{"/Home", rootReal, 0});

        while (!q.empty()) {
            Node node = q.front();
            q.pop();

            if (node.depth > maxDepth) continue;
            if (!fs::exists(node.real) || !fs::is_directory(node.real)) {
                snapshot[node.virt] = json::array();
                continue;
            }

            std::vector<fs::directory_entry> children;
            std::error_code ec;
            for (const auto &entry : fs::directory_iterator(node.real, fs::directory_options::skip_permission_denied, ec)) {
                if (ec) break;
                children.push_back(entry);
                if (static_cast<int>(children.size()) >= maxEntriesPerDir) break;
            }

            std::sort(children.begin(), children.end(), [](const fs::directory_entry &a, const fs::directory_entry &b) {
                const bool ad = a.is_directory();
                const bool bd = b.is_directory();
                if (ad != bd) return ad > bd;
                return a.path().filename().string() < b.path().filename().string();
            });

            json entries = json::array();
            for (const auto &entry : children) {
                entries.push_back(makeEntry(entry));
            }
            snapshot[node.virt] = entries;

            if (node.depth < maxDepth) {
                for (const auto &entry : children) {
                    std::error_code isDirEc;
                    if (!entry.is_directory(isDirEc) || isDirEc) continue;
                    const std::string name = entry.path().filename().string();
                    const std::string childVirt = node.virt + "/" + name;
                    q.push(Node{childVirt, entry.path(), node.depth + 1});
                }
            }
        }

        return snapshot;
    }

    json loadCachedSnapshot() const {
        if (!fs::exists(paths_.snapshotFile)) return json::object();
        std::ifstream in(paths_.snapshotFile);
        if (!in) return json::object();
        try {
            json value;
            in >> value;
            if (value.is_object()) return value;
        } catch (...) {
            return json::object();
        }
        return json::object();
    }

    void persistSnapshot(const json &snapshot) {
        std::ofstream out(paths_.snapshotFile);
        out << snapshot.dump(2);
        out.close();
    }

    void notifyChanged(const std::string &source, const json &snapshot) {
        if (!onChange_) return;
        json evt = {
            {"type", "fs.changed"},
            {"payload",
             {
                 {"source", source},
                 {"snapshot", snapshot},
                 {"changedAt", isoNow()}
             }}
        };
        onChange_(evt);
    }

    struct DirCacheEntry {
        std::chrono::steady_clock::time_point builtAt{};
        std::vector<json> entries;
        int skippedErrors = 0;
    };

    Paths paths_;
    fs::path realRoot_;
    mutable std::mutex rootMutex_;
    std::atomic<bool> watcherRunning_;
    std::thread watcher_;
    std::atomic<std::uint64_t> opCounter_{0}; 
    std::function<void(const json &)> onChange_;

    std::unordered_map<std::string, DirCacheEntry> dirCache_;
    mutable std::mutex dirCacheMutex_;

    json cachedSnapshot_;
    mutable std::mutex mutex_;
};

class MMMApp {
public:
    explicit MMMApp(fs::path executablePath)
        : paths_(resolvePaths()),
          logger_(paths_.logFile),
          ioPool_(computeIoThreads()),
          config_(paths_),
          fsService_(paths_),
          webview_(true, nullptr),
          executablePath_(std::move(executablePath)) {
        const auto maybeRoot = config_.get("mmm.fs.root");
        if (maybeRoot.has_value() && maybeRoot->is_string()) {
            const std::string rootStr = maybeRoot->get<std::string>();
            if (!rootStr.empty()) {
                const json res = fsService_.setRoot(json::object({{"realRoot", rootStr}}));
                if (!res.value("ok", false)) {
                    logger_.log("warn", "native", "fs.root.invalid", "Failed to apply configured root", json::object({
                        {"realRoot", rootStr},
                        {"error", res.value("error", json::object())}
                    }));
                } else {
                    const std::string stored = res.value("realRootStored", res.value("realRoot", std::string()));
                    if (!stored.empty() && stored != rootStr) {
                        config_.set("mmm.fs.root", stored);
                    }
                }
            }
        }

        fsService_.setOnChange([this](const json &evt) {
            emitEvent(evt);
        });

        logger_.log("info", "native", "app.init", "MMM native host initialized", json::object({
            {"logFile", paths_.logFile.string()}
        }));
    }

    int run(const fs::path &workspaceRoot, const std::string &initialPath = std::string(), const std::string &sessionToken = std::string()) {
        workspaceRoot_ = workspaceRoot;
        const fs::path uiIndex = workspaceRoot / "ui" / "index.html";
        if (!fs::exists(uiIndex)) {
            std::cerr << "Missing UI entrypoint: " << uiIndex << "\n";
            logger_.log("error", "native", "app.run.missingUI", uiIndex.string());
            return 1;
        }

        logger_.log("info", "native", "app.run", std::string(), json::object({
            {"workspaceRoot", workspaceRoot.string()},
            {"uiIndex", uiIndex.string()},
            {"initialPath", initialPath},
            {"hasSessionToken", !sessionToken.empty()},
            {"logFile", paths_.logFile.string()}
        }));

        // Preload snapshot asynchronously so first render can be native-driven.
        auto preload = ioPool_.enqueue([this]() {
            return fsService_.snapshot();
        });
        preload.wait();

        ensureSchemaUpToDate();

        const WindowState windowState = loadWindowState();

        bindBridge();
        injectHostScript(windowState);

        webview_.set_title("MMM Explorer");
        webview_.set_size(kMinWindowWidth, kMinWindowHeight, WEBVIEW_HINT_MIN);
        webview_.set_size(windowState.width, windowState.height, WEBVIEW_HINT_NONE);
        attachNativeWindowTracking(windowState);

        std::string url = std::string("file://") + uiIndex.string();
        bool hasQuery = false;
        if (!initialPath.empty()) {
            url += hasQuery ? "&" : "?";
            url += "path=" + urlEncode(initialPath);
            hasQuery = true;
        }
        if (!sessionToken.empty()) {
            url += hasQuery ? "&" : "?";
            url += "session=" + urlEncode(sessionToken);
            hasQuery = true;
        }

        logger_.log("info", "native", "webview.navigate", url);
        webview_.navigate(url);

        fsService_.startWatcher();
        webview_.run();
        fsService_.stopWatcher();
        return 0;
    }

private:
    struct WindowState {
        int x = 80;
        int y = 60;
        int width = 1560;
        int height = 980;
        bool maximized = false;
    };

    static constexpr int kMinWindowWidth = 1100;
    static constexpr int kMinWindowHeight = 720;

    static constexpr int kCurrentSchemaVersion = 1;

    static int parseSchemaVersion(const json &value) {
        try {
            if (value.is_number_integer()) return value.get<int>();
            if (value.is_number_unsigned()) return static_cast<int>(value.get<unsigned int>());
            if (value.is_string()) return std::stoi(value.get<std::string>());
        } catch (...) {
        }
        return 0;
    }

    void ensureSchemaUpToDate() {
        auto fut = ioPool_.enqueue([this]() {
            const auto maybe = config_.get("mmm.schemaVersion");
            const int stored = maybe.has_value() ? parseSchemaVersion(*maybe) : 0;

            if (stored <= 0) {
                config_.set("mmm.schemaVersion", kCurrentSchemaVersion);
                return true;
            }

            if (stored > kCurrentSchemaVersion) {
                std::cerr << "Config schemaVersion (" << stored << ") is newer than this binary (" << kCurrentSchemaVersion << ")\n";
                return true;
            }

            if (stored < kCurrentSchemaVersion) {
                // Placeholder for Phase 2 migrations.
                config_.set("mmm.schemaVersion", kCurrentSchemaVersion);
            }
            return true;
        });
        fut.get();
    }

    static std::size_t computeIoThreads() {
        const auto hc = std::max(2u, std::thread::hardware_concurrency());
        return static_cast<std::size_t>(std::min(8u, std::max(2u, hc - 2u)));
    }

    static int clampInt(int value, int minValue, int maxValue) {
        return std::max(minValue, std::min(maxValue, value));
    }

    static WindowState normalizeWindowState(const WindowState &state) {
        WindowState out = state;
        out.width = std::max(kMinWindowWidth, out.width);
        out.height = std::max(kMinWindowHeight, out.height);
        out.x = clampInt(out.x, -10000, 10000);
        out.y = clampInt(out.y, -10000, 10000);
        return out;
    }

    static WindowState parseWindowState(const json &value) {
        WindowState out;
        if (!value.is_object()) return out;
        out.x = value.value("x", out.x);
        out.y = value.value("y", out.y);
        out.width = value.value("width", out.width);
        out.height = value.value("height", out.height);
        out.maximized = value.value("maximized", false);
        return normalizeWindowState(out);
    }

    static json windowStateToJson(const WindowState &state) {
        return {
            {"x", state.x},
            {"y", state.y},
            {"width", state.width},
            {"height", state.height},
            {"maximized", state.maximized}
        };
    }

    WindowState loadWindowState() {
        auto fut = ioPool_.enqueue([this]() {
            return config_.get("mmm-window-state");
        });
        const auto maybeValue = fut.get();
        if (!maybeValue.has_value()) {
            return normalizeWindowState(WindowState{});
        }
        return parseWindowState(*maybeValue);
    }

    json persistWindowState(const json &payload) {
        const WindowState normalized = parseWindowState(payload);
        const json stored = windowStateToJson(normalized);
        auto fut = ioPool_.enqueue([this, stored]() {
            config_.set("mmm-window-state", stored);
            return true;
        });
        fut.get();
        return json::object({{"ok", true}, {"windowState", stored}});
    }

    void persistWindowStateAsync(const WindowState &state) {
        const json stored = windowStateToJson(normalizeWindowState(state));
        ioPool_.enqueue([this, stored]() {
            config_.set("mmm-window-state", stored);
            return true;
        });
    }

#ifdef MMM_PLATFORM_LINUX
    static gboolean onGtkConfigureEvent(GtkWidget *_widget, GdkEvent *event, gpointer userData) {
        if (!event || event->type != GDK_CONFIGURE) return FALSE;
        auto *self = static_cast<MMMApp *>(userData);
        auto *cfg = reinterpret_cast<GdkEventConfigure *>(event);
        if (!self || !cfg) return FALSE;
        self->handleGtkConfigure(cfg->x, cfg->y, cfg->width, cfg->height);
        return FALSE;
    }

    static gboolean onGtkWindowStateEvent(GtkWidget *_widget, GdkEventWindowState *event, gpointer userData) {
        auto *self = static_cast<MMMApp *>(userData);
        if (!self || !event) return FALSE;
        const bool maximized = (event->new_window_state & GDK_WINDOW_STATE_MAXIMIZED) != 0;
        self->handleGtkWindowState(maximized);
        return FALSE;
    }

    void handleGtkConfigure(int x, int y, int width, int height) {
        WindowState next;
        {
            std::lock_guard<std::mutex> lock(windowStateMutex_);
            next = currentWindowState_;
            next.x = x;
            next.y = y;
            next.width = std::max(kMinWindowWidth, width);
            next.height = std::max(kMinWindowHeight, height);
            currentWindowState_ = normalizeWindowState(next);
        }
        persistWindowStateAsync(next);
    }

    void handleGtkWindowState(bool maximized) {
        WindowState next;
        {
            std::lock_guard<std::mutex> lock(windowStateMutex_);
            next = currentWindowState_;
            next.maximized = maximized;
            currentWindowState_ = normalizeWindowState(next);
        }
        persistWindowStateAsync(next);
    }

    void attachNativeWindowTracking(const WindowState &initialWindowState) {
        auto windowResult = webview_.window();
        if (!windowResult.ok()) return;
        auto *widget = static_cast<GtkWidget *>(windowResult.value());
        if (!widget) return;
        auto *window = GTK_WINDOW(widget);
        if (!window) return;

        const WindowState normalized = normalizeWindowState(initialWindowState);
        {
            std::lock_guard<std::mutex> lock(windowStateMutex_);
            currentWindowState_ = normalized;
        }

        gtk_window_set_default_size(window, normalized.width, normalized.height);
        gtk_window_resize(window, normalized.width, normalized.height);
        gtk_window_move(window, normalized.x, normalized.y);
        if (normalized.maximized) {
            gtk_window_maximize(window);
        }

        g_signal_connect(window, "configure-event", G_CALLBACK(MMMApp::onGtkConfigureEvent), this);
        g_signal_connect(window, "window-state-event", G_CALLBACK(MMMApp::onGtkWindowStateEvent), this);
    }
#else
    void attachNativeWindowTracking(const WindowState &_initialWindowState) {
    }
#endif

    void emitEvent(const json &evt) {
        webview_.dispatch([this, evt]() {
            const std::string js = "window.__mmmHostEmit && window.__mmmHostEmit(" + evt.dump() + ");";
            webview_.eval(js);
        });
    }

    static bool isPermissionCode(const std::string &code) {
        return code == "EACCES" || code == "EPERM";
    }

    static bool responseHasPermissionError(const json &res) {
        if (!res.is_object()) return false;

        const json err = res.value("error", json::object());
        if (err.is_object()) {
            const std::string code = err.value("code", std::string());
            if (isPermissionCode(code)) return true;
        }

        const json errors = res.value("errors", json::array());
        if (errors.is_array()) {
            for (const auto &e : errors) {
                if (!e.is_object()) continue;
                const std::string code = e.value("code", std::string());
                if (isPermissionCode(code)) return true;
            }
        }

        return false;
    }

#ifdef MMM_PLATFORM_LINUX
    static bool pkexecAvailable() {
        return access("/usr/bin/pkexec", X_OK) == 0 ||
               access("/bin/pkexec", X_OK) == 0 ||
               access("/usr/local/bin/pkexec", X_OK) == 0;
    }
#endif

    json maybeAnnotateCanElevate(json res, bool elevatedAlready) const {
#ifdef MMM_PLATFORM_LINUX
        if (elevatedAlready) return res;
        if (!pkexecAvailable()) return res;
        if (!responseHasPermissionError(res)) return res;
        res["canElevate"] = true;
        res["elevation"] = "pkexec";
#endif
        return res;
    }

    json runElevatedFsViaPkexec(const std::string &fsAction, const json &payload) {
#ifdef MMM_PLATFORM_LINUX
        if (executablePath_.empty()) {
            return json::object({{"ok", false}, {"error", json::object({{"code", "EIO"}, {"message", "executablePath is empty"}})}});
        }
        if (!pkexecAvailable()) {
            return json::object({{"ok", false}, {"error", json::object({{"code", "ENOSYS"}, {"message", "pkexec not available"}})}});
        }

        json elevatedPayload = payload;
        const json rootInfo = fsService_.getRootInfo();
        const std::string realRoot = rootInfo.value("realRoot", std::string());
        if (realRoot.empty()) {
            return json::object({{"ok", false}, {"error", json::object({{"code", "EIO"}, {"message", "Missing real root"}})}});
        }
        elevatedPayload["elevateRealRoot"] = realRoot;

        const std::string stdinStr = elevatedPayload.dump();
        const auto started = std::chrono::steady_clock::now();

        int inPipe[2] = {-1, -1};
        int outPipe[2] = {-1, -1};
        int errPipe[2] = {-1, -1};
        if (pipe(inPipe) != 0 || pipe(outPipe) != 0 || pipe(errPipe) != 0) {
            const std::string msg = std::strerror(errno);
            if (inPipe[0] != -1) close(inPipe[0]);
            if (inPipe[1] != -1) close(inPipe[1]);
            if (outPipe[0] != -1) close(outPipe[0]);
            if (outPipe[1] != -1) close(outPipe[1]);
            if (errPipe[0] != -1) close(errPipe[0]);
            if (errPipe[1] != -1) close(errPipe[1]);
            return json::object({{"ok", false}, {"error", json::object({{"code", "EIO"}, {"message", msg}})}});
        }

        auto setNonBlocking = [](int fd) {
            const int flags = fcntl(fd, F_GETFL, 0);
            if (flags >= 0) {
                fcntl(fd, F_SETFL, flags | O_NONBLOCK);
            }
        };

        setNonBlocking(outPipe[0]);
        setNonBlocking(errPipe[0]);

        const std::string exe = executablePath_.string();
        const std::string actionCopy = fsAction;

        pid_t pid = fork();
        if (pid == 0) {
            (void)dup2(inPipe[0], STDIN_FILENO);
            (void)dup2(outPipe[1], STDOUT_FILENO);
            (void)dup2(errPipe[1], STDERR_FILENO);

            close(inPipe[0]);
            close(inPipe[1]);
            close(outPipe[0]);
            close(outPipe[1]);
            close(errPipe[0]);
            close(errPipe[1]);

            execlp("pkexec", "pkexec", exe.c_str(), "--admin-fs", actionCopy.c_str(), (char *)nullptr);
            _exit(127);
        }

        if (pid < 0) {
            const std::string msg = std::strerror(errno);
            close(inPipe[0]);
            close(inPipe[1]);
            close(outPipe[0]);
            close(outPipe[1]);
            close(errPipe[0]);
            close(errPipe[1]);
            return json::object({{"ok", false}, {"error", json::object({{"code", "EIO"}, {"message", msg}})}});
        }

        close(inPipe[0]);
        close(outPipe[1]);
        close(errPipe[1]);

        // Write stdin payload then close.
        {
            std::size_t off = 0;
            while (off < stdinStr.size()) {
                const ssize_t n = write(inPipe[1], stdinStr.data() + off, stdinStr.size() - off);
                if (n > 0) {
                    off += static_cast<std::size_t>(n);
                    continue;
                }
                if (n < 0 && errno == EINTR) continue;
                break;
            }
            close(inPipe[1]);
        }

        const std::size_t maxOutputBytes = 1024ull * 1024ull;

        bool timedOut = false;
        bool stdoutOpen = true;
        bool stderrOpen = true;
        bool outTruncated = false;
        bool errTruncated = false;

        std::string stdoutBuf;
        std::string stderrBuf;
        stdoutBuf.reserve(64 * 1024);
        stderrBuf.reserve(64 * 1024);

        int status = 0;
        bool exited = false;

        auto drainFd = [&](int fd, std::string &buf, bool &truncFlag) -> bool {
            char tmp[4096];
            for (;;) {
                const ssize_t n = read(fd, tmp, sizeof(tmp));
                if (n > 0) {
                    if (buf.size() < maxOutputBytes) {
                        const std::size_t take = std::min<std::size_t>(static_cast<std::size_t>(n), maxOutputBytes - buf.size());
                        buf.append(tmp, tmp + take);
                        if (take < static_cast<std::size_t>(n)) {
                            truncFlag = true;
                        }
                    } else {
                        truncFlag = true;
                    }
                    continue;
                }
                if (n == 0) return false;
                if (errno == EAGAIN || errno == EWOULDBLOCK) return true;
                return false;
            }
        };

        const int timeoutMs = 600000;
        auto deadline = std::chrono::steady_clock::now() + std::chrono::milliseconds(timeoutMs);

        while (stdoutOpen || stderrOpen || !exited) {
            const auto now = std::chrono::steady_clock::now();
            if (!timedOut && now >= deadline) {
                timedOut = true;
                kill(pid, SIGKILL);
            }

            int waitStatus = 0;
            const pid_t w = waitpid(pid, &waitStatus, WNOHANG);
            if (w == pid) {
                status = waitStatus;
                exited = true;
            }

            struct pollfd fds[2];
            nfds_t nfds = 0;
            if (stdoutOpen) {
                fds[nfds].fd = outPipe[0];
                fds[nfds].events = POLLIN;
                fds[nfds].revents = 0;
                nfds += 1;
            }
            if (stderrOpen) {
                fds[nfds].fd = errPipe[0];
                fds[nfds].events = POLLIN;
                fds[nfds].revents = 0;
                nfds += 1;
            }

            int pollTimeout = 50;
            if (timedOut) pollTimeout = 0;

            if (nfds > 0) {
                (void)poll(fds, nfds, pollTimeout);
            }

            if (stdoutOpen) stdoutOpen = drainFd(outPipe[0], stdoutBuf, outTruncated);
            if (stderrOpen) stderrOpen = drainFd(errPipe[0], stderrBuf, errTruncated);

            if (exited && !stdoutOpen && !stderrOpen) break;
        }

        close(outPipe[0]);
        close(errPipe[0]);

        if (!exited) {
            (void)waitpid(pid, &status, 0);
            exited = true;
        }

        auto trim = [](std::string s) {
            auto notSpace = [](unsigned char c) { return !std::isspace(c); };
            s.erase(s.begin(), std::find_if(s.begin(), s.end(), notSpace));
            s.erase(std::find_if(s.rbegin(), s.rend(), notSpace).base(), s.end());
            return s;
        };

        const std::string outTrim = trim(stdoutBuf);
        if (outTrim.empty()) {
            const auto ended = std::chrono::steady_clock::now();
            const auto durMs = std::chrono::duration_cast<std::chrono::milliseconds>(ended - started).count();
            return json::object({
                {"ok", false},
                {"error", json::object({{"code", "ELEVATE"}, {"message", timedOut ? "Elevation timed out" : "No response from elevated helper"}})},
                {"timedOut", timedOut},
                {"stderr", stderrBuf},
                {"truncated", json::object({{"stdout", outTruncated}, {"stderr", errTruncated}})},
                {"durationMs", durMs}
            });
        }

        try {
            return json::parse(outTrim);
        } catch (...) {
            const auto ended = std::chrono::steady_clock::now();
            const auto durMs = std::chrono::duration_cast<std::chrono::milliseconds>(ended - started).count();
            return json::object({
                {"ok", false},
                {"error", json::object({{"code", "ELEVATE"}, {"message", "Invalid JSON from elevated helper"}})},
                {"stdout", stdoutBuf},
                {"stderr", stderrBuf},
                {"truncated", json::object({{"stdout", outTruncated}, {"stderr", errTruncated}})},
                {"durationMs", durMs}
            });
        }
#else
        (void)fsAction;
        (void)payload;
        return json::object({{"ok", false}, {"error", json::object({{"code", "ENOSYS"}, {"message", "Elevation not supported"}})}});
#endif
    }

    json handleAction(const std::string &action, const json &payload) {
        if (action == "log.write") {
            const std::string level = payload.value("level", std::string("info"));
            const std::string source = payload.value("source", std::string("ui"));
            const std::string event = payload.value("event", std::string("log"));
            const std::string message = payload.value("message", std::string(""));
            const json data = payload.value("data", json::object());
            logger_.log(level, source, event, message, data);
            return json::object({{"ok", true}, {"logFile", paths_.logFile.string()}});
        }

        logger_.log("debug", "bridge", "invoke", std::string(), json::object({
            {"action", action},
            {"payload", Logger::summarizeJson(payload, 2, 10)}
        }));

        if (action == "sys.info") {
            auto tilde = [this](const fs::path &p) {
                const std::string full = p.string();
                const std::string home = paths_.home.string();
                if (home.empty()) return full;
                if (full == home) return std::string("~");
                if (full.rfind(home + "/", 0) == 0) {
                    return std::string("~/") + full.substr(home.size() + 1);
                }
                return full;
            };

            const bool isLinux =
#ifdef MMM_PLATFORM_LINUX
                true;
#else
                false;
#endif

            const bool canElevate =
#ifdef MMM_PLATFORM_LINUX
                pkexecAvailable();
#else
                false;
#endif

            json out = json::object({
                {"ok", true},
                {"platform", isLinux ? "linux" : "unknown"},
                {"workspaceRoot", workspaceRoot_.string()},
                {"executablePath", executablePath_.string()},
                {"paths", json::object({
                    {"home", paths_.home.string()},
                    {"homeTilde", "~"},
                    {"configDir", tilde(paths_.configDir)},
                    {"stateDir", tilde(paths_.stateDir)},
                    {"cacheDir", tilde(paths_.cacheDir)},
                    {"logDir", tilde(paths_.logDir)},
                    {"kvConfigFile", tilde(paths_.kvConfigFile)},
                    {"structuredConfigFile", tilde(paths_.structuredConfigFile)},
                    {"snapshotFile", tilde(paths_.snapshotFile)},
                    {"logFile", tilde(paths_.logFile)}
                })},
                {"fsRoot", fsService_.getRootInfo()},
                {"capabilities", json::object({
                    {"fs.listDir", true},
                    {"fs.mkdir", true},
                    {"fs.createFile", true},
                    {"fs.rename", true},
                    {"fs.delete", true},
                    {"fs.copy", true},
                    {"fs.move", true},
                    {"fs.elevate", canElevate},
                    {"term.exec", isLinux}
                })}
            });

            return out;
        }

        if (action == "config.getAll") {
            const std::string ns = payload.value("namespace", std::string(""));
            auto fut = ioPool_.enqueue([this, ns]() { return config_.getAll(ns); });
            return fut.get();
        }

        if (action == "config.set") {
            const std::string key = payload.value("key", std::string(""));
            json value = payload.value("value", json(""));
            auto fut = ioPool_.enqueue([this, key, value]() {
                config_.set(key, value);
                return true;
            });
            fut.get();
            emitEvent({{"type", "config.changed"}, {"payload", {{"key", key}, {"value", value}}}});
            return json::object({{"ok", true}});
        }

        if (action == "config.remove") {
            const std::string key = payload.value("key", std::string(""));
            auto fut = ioPool_.enqueue([this, key]() {
                config_.remove(key);
                return true;
            });
            fut.get();
            emitEvent({{"type", "config.changed"}, {"payload", {{"key", key}, {"removed", true}}}});
            return json::object({{"ok", true}});
        }

        if (action == "config.writeStructured") {
            const std::string key = payload.value("key", std::string("mmm.config"));
            const json value = payload.value("value", json::object());
            auto fut = ioPool_.enqueue([this, key, value]() {
                config_.writeStructured(key, value);
                return true;
            });
            fut.get();
            emitEvent({{"type", "config.changed"}, {"payload", {{"key", key}, {"value", value}}}});
            return json::object({{"ok", true}});
        }

        if (action == "fs.snapshot") {
            auto fut = ioPool_.enqueue([this]() { return fsService_.snapshot(); });
            return fut.get();
        }

        if (action == "fs.seed") {
            const json snapshot = payload.value("snapshot", json::object());
            auto fut = ioPool_.enqueue([this, snapshot]() {
                fsService_.seed(snapshot);
                return true;
            });
            fut.get();
            return json::object({{"ok", true}});
        }

        if (action == "fs.applyOperation") {
            auto fut = ioPool_.enqueue([this, payload]() { return fsService_.applyOperation(payload); });
            return fut.get();
        }

        if (action == "fs.listDir") {
            auto fut = ioPool_.enqueue([this, payload]() { return fsService_.listDir(payload); });
            return fut.get();
        }

        if (action == "fs.getRoot") {
            auto fut = ioPool_.enqueue([this]() { return fsService_.getRootInfo(); });
            return fut.get();
        }

        if (action == "fs.setRoot") {
            auto fut = ioPool_.enqueue([this, payload]() {
                json res = fsService_.setRoot(payload);
                if (res.value("ok", false)) {
                    const std::string stored = res.value("realRootStored", res.value("realRoot", std::string()));
                    config_.set("mmm.fs.root", stored);
                }
                return res;
            });
            const json res = fut.get();
            if (res.value("ok", false)) {
                const std::string stored = res.value("realRootStored", res.value("realRoot", std::string()));
                emitEvent({{"type", "config.changed"}, {"payload", {{"key", "mmm.fs.root"}, {"value", stored}}}});
            }
            return res;
        }

        if (action == "fs.mkdir") {
            auto fut = ioPool_.enqueue([this, payload]() {
                const bool elevate = payload.value("elevate", false);
                if (elevate) {
                    return runElevatedFsViaPkexec("fs.mkdir", payload);
                }
                json res = fsService_.mkdirIntent(payload);
                return maybeAnnotateCanElevate(std::move(res), false);
            });
            return fut.get();
        }

        if (action == "fs.createFile") {
            auto fut = ioPool_.enqueue([this, payload]() {
                const bool elevate = payload.value("elevate", false);
                if (elevate) {
                    return runElevatedFsViaPkexec("fs.createFile", payload);
                }
                json res = fsService_.createFileIntent(payload);
                return maybeAnnotateCanElevate(std::move(res), false);
            });
            return fut.get();
        }

        if (action == "fs.rename") {
            auto fut = ioPool_.enqueue([this, payload]() {
                const bool elevate = payload.value("elevate", false);
                if (elevate) {
                    return runElevatedFsViaPkexec("fs.rename", payload);
                }
                json res = fsService_.renameIntent(payload);
                return maybeAnnotateCanElevate(std::move(res), false);
            });
            return fut.get();
        }

        if (action == "fs.delete") {
            auto fut = ioPool_.enqueue([this, payload]() {
                const bool elevate = payload.value("elevate", false);
                if (elevate) {
                    return runElevatedFsViaPkexec("fs.delete", payload);
                }
                json res = fsService_.deleteIntent(payload);
                return maybeAnnotateCanElevate(std::move(res), false);
            });
            return fut.get();
        }

        if (action == "fs.copy") {
            auto fut = ioPool_.enqueue([this, payload]() {
                const bool elevate = payload.value("elevate", false);
                if (elevate) {
                    return runElevatedFsViaPkexec("fs.copy", payload);
                }
                json res = fsService_.copyIntent(payload);
                return maybeAnnotateCanElevate(std::move(res), false);
            });
            return fut.get();
        }

        if (action == "fs.move") {
            auto fut = ioPool_.enqueue([this, payload]() {
                const bool elevate = payload.value("elevate", false);
                if (elevate) {
                    return runElevatedFsViaPkexec("fs.move", payload);
                }
                json res = fsService_.moveIntent(payload);
                return maybeAnnotateCanElevate(std::move(res), false);
            });
            return fut.get();
        }

        if (action == "term.exec") {
            auto fut = ioPool_.enqueue([this, payload]() { return fsService_.termExec(payload); });
            return fut.get();
        }

        if (action == "window.getState") {
            const WindowState state = loadWindowState();
            return json::object({{"ok", true}, {"windowState", windowStateToJson(state)}});
        }

        if (action == "window.saveState") {
            return persistWindowState(payload);
        }

        if (action == "app.newWindow") {
            const std::string path = payload.value("path", std::string("/Home"));
            const std::string sessionToken = payload.value("sessionToken", std::string(""));
            logger_.log("info", "native", "app.newWindow.request", std::string(), json::object({
                {"path", path},
                {"hasSessionToken", !sessionToken.empty()}
            }));
            const bool started = launchNewWindow(path, sessionToken);
            logger_.log(started ? "info" : "error", "native", "app.newWindow.result", std::string(), json::object({
                {"path", path},
                {"started", started},
                {"hasSessionToken", !sessionToken.empty()}
            }));
            return json::object({{"ok", started}});
        }

        logger_.log("warn", "bridge", "unknownAction", std::string(), json::object({{"action", action}}));
        return json::object({
            {"ok", false},
            {"error", json::object({{"code", "ENOSYS"}, {"message", "Unknown action"}})},
            {"action", action}
        });
    }

    bool launchNewWindow(const std::string &path, const std::string &sessionToken) {
#ifdef MMM_PLATFORM_LINUX
        if (executablePath_.empty()) {
            logger_.log("error", "native", "app.newWindow.error", "executablePath is empty");
            return false;
        }

        logger_.log("info", "native", "app.newWindow.fork", std::string(), json::object({
            {"path", path},
            {"hasSessionToken", !sessionToken.empty()},
            {"exe", executablePath_.string()},
            {"workspaceRoot", workspaceRoot_.string()}
        }));

        pid_t pid = fork();
        if (pid < 0) {
            logger_.log("error", "native", "app.newWindow.forkFailed", std::string(), json::object({
                {"path", path}
            }));
            return false;
        }

        if (pid == 0) {
            if (sessionToken.empty()) {
                execl(executablePath_.c_str(),
                      executablePath_.c_str(),
                      workspaceRoot_.string().c_str(),
                      path.c_str(),
                      nullptr);
            } else {
                execl(executablePath_.c_str(),
                      executablePath_.c_str(),
                      workspaceRoot_.string().c_str(),
                      path.c_str(),
                      sessionToken.c_str(),
                      nullptr);
            }
            _exit(127);
        }

        logger_.log("info", "native", "app.newWindow.forked", std::string(), json::object({
            {"pid", static_cast<long long>(pid)},
            {"path", path},
            {"hasSessionToken", !sessionToken.empty()}
        }));
        return true;
#else
        (void)path;
        (void)sessionToken;
        return false;
#endif
    }

    void bindBridge() {
        webview_.bind("mmmInvoke", [this](const std::string &req) -> std::string {
            try {
                json args = json::parse(req);
                const std::string action = args.size() > 0 ? args[0].get<std::string>() : std::string("");
                const json payload = args.size() > 1 ? args[1] : json::object();
                json result = handleAction(action, payload);
                return result.dump();
            } catch (const std::exception &err) {
                logger_.log("error", "bridge", "invoke.exception", err.what());
                json out = {
                    {"ok", false},
                    {"error", json::object({{"code", "EINVAL"}, {"message", std::string("bridge parse/dispatch error: ") + err.what()}})}
                };
                return out.dump();
            }
        });
    }

    void injectHostScript(const WindowState &initialWindowState) {
        (void)initialWindowState;
        const std::string iconsRaw = readTextFile(workspaceRoot_ / "ui" / "icons.svg");
        const std::string iconsBase64 = base64Encode(iconsRaw);
        webview_.init(R"(
            (function () {
                const __listeners = new Set();

                const __iconSpriteBase64 = ")" + iconsBase64 + R"(";

                function __installInlineSprite() {
                    if (!__iconSpriteBase64) return;
                    if (document.getElementById("mmm-icon-sprite")) return;
                    try {
                        const raw = atob(__iconSpriteBase64);
                        const wrapper = document.createElement("div");
                        wrapper.innerHTML = raw;
                        const svg = wrapper.querySelector("svg");
                        if (!svg) return;
                        svg.id = "mmm-icon-sprite";
                        svg.setAttribute("aria-hidden", "true");
                        svg.style.position = "absolute";
                        svg.style.width = "0";
                        svg.style.height = "0";
                        svg.style.overflow = "hidden";
                        const host = document.body || document.documentElement;
                        if (host) host.prepend(svg);
                    } catch (_err) {
                    }
                }

                function __rewriteIconUses(root) {
                    const scope = root || document;
                    scope.querySelectorAll("use").forEach(function (node) {
                        const href = node.getAttribute("href") || node.getAttribute("xlink:href") || "";
                        if (!href) return;
                        if (href.startsWith("#")) return;
                        let local = "";
                        if (href.startsWith("icons.svg#")) {
                            local = href.slice("icons.svg".length);
                        } else {
                            const hashIdx = href.indexOf("#");
                            if (hashIdx === -1) return;
                            local = href.slice(hashIdx);
                        }
                        node.setAttribute("href", local);
                        node.setAttribute("xlink:href", local);
                    });
                }

                function __bootstrapIcons() {
                    __installInlineSprite();
                    __rewriteIconUses(document);

                    const observer = new MutationObserver(function (records) {
                        records.forEach(function (record) {
                            if (!record.addedNodes) return;
                            record.addedNodes.forEach(function (n) {
                                if (!(n instanceof Element)) return;
                                __rewriteIconUses(n);
                            });
                        });
                    });
                    observer.observe(document.documentElement, { childList: true, subtree: true });
                }

                if (document.readyState === "loading") {
                    document.addEventListener("DOMContentLoaded", __bootstrapIcons, { once: true });
                } else {
                    __bootstrapIcons();
                }

                window.__mmmHostEmit = function (evt) {
                    __listeners.forEach(function (cb) {
                        try { cb(evt); } catch (_err) {}
                    });
                };

                window.mmmHost = {
                    invoke: function (action, payload) {
                        return window.mmmInvoke(action, payload).then(function (response) {
                            if (typeof response === "string") {
                                try { return JSON.parse(response); } catch (_err) { return response; }
                            }
                            return response;
                        });
                    },
                    onEvent: function (cb) {
                        if (typeof cb !== "function") return;
                        __listeners.add(cb);
                    },
                    alert: function (message) { window.alert(message); },
                    confirm: function (message) { return window.confirm(message); },
                    prompt: function (message, value) { return window.prompt(message, value); },
                    openExternal: function (target) {
                        if (typeof target !== "string") return;
                        window.open(target, "_blank");
                    }
                };
            })();
        )");
    }

    Paths paths_;
    Logger logger_;
    ThreadPool ioPool_;
    ConfigStore config_;
    FsService fsService_;
    webview::webview webview_;
    fs::path workspaceRoot_;
    fs::path executablePath_;
    std::mutex windowStateMutex_;
    WindowState currentWindowState_{};
};

static int runAdminFsMode(int argc, char **argv) {
    // Usage: <exe> --admin-fs <fs.action>
    if (argc < 3) {
        json out = json::object({{"ok", false}, {"error", json::object({{"code", "EINVAL"}, {"message", "Missing fs action"}})}});
        std::cout << out.dump();
        return 2;
    }

    const std::string action = argv[2] ? std::string(argv[2]) : std::string();
    if (action.empty()) {
        json out = json::object({{"ok", false}, {"error", json::object({{"code", "EINVAL"}, {"message", "Empty fs action"}})}});
        std::cout << out.dump();
        return 2;
    }

    std::string input;
    input.reserve(64 * 1024);
    {
        char buf[4096];
        while (std::cin.good()) {
            std::cin.read(buf, sizeof(buf));
            const std::streamsize n = std::cin.gcount();
            if (n <= 0) break;
            if (input.size() + static_cast<std::size_t>(n) > 1024ull * 1024ull) {
                json out = json::object({{"ok", false}, {"error", json::object({{"code", "E2BIG"}, {"message", "Payload too large"}})}});
                std::cout << out.dump();
                return 2;
            }
            input.append(buf, buf + n);
        }
    }

    json payload;
    try {
        payload = input.empty() ? json::object() : json::parse(input);
    } catch (...) {
        json out = json::object({{"ok", false}, {"error", json::object({{"code", "EINVAL"}, {"message", "Invalid JSON payload"}})}});
        std::cout << out.dump();
        return 2;
    }

    const std::string elevateRoot = payload.value("elevateRealRoot", std::string());
    if (elevateRoot.empty()) {
        json out = json::object({{"ok", false}, {"error", json::object({{"code", "EINVAL"}, {"message", "Missing elevateRealRoot"}})}});
        std::cout << out.dump();
        return 2;
    }

    Paths adminPaths;
    adminPaths.home = fs::path("/tmp");
    adminPaths.configDir = adminPaths.home;
    adminPaths.stateDir = adminPaths.home;
    adminPaths.cacheDir = adminPaths.home;
    adminPaths.logDir = adminPaths.home;
    adminPaths.kvConfigFile = adminPaths.home / "mmm_admin_config_kv.json";
    adminPaths.structuredConfigFile = adminPaths.home / "mmm_admin_config_structured.json";
    adminPaths.snapshotFile = adminPaths.home / "mmm_admin_snapshot.json";
    adminPaths.logFile = adminPaths.home / "mmm_admin.log";

    FsService svc(adminPaths);
    const json setRes = svc.setRoot(json::object({{"realRoot", elevateRoot}}));
    if (!setRes.value("ok", false)) {
        std::cout << setRes.dump();
        return 1;
    }

    // Strip elevation-only fields.
    if (payload.is_object()) {
        payload.erase("elevateRealRoot");
        payload.erase("elevate");
    }

    json res;
    if (action == "fs.mkdir") {
        res = svc.mkdirIntent(payload);
    } else if (action == "fs.createFile") {
        res = svc.createFileIntent(payload);
    } else if (action == "fs.rename") {
        res = svc.renameIntent(payload);
    } else if (action == "fs.delete") {
        res = svc.deleteIntent(payload);
    } else if (action == "fs.copy") {
        res = svc.copyIntent(payload);
    } else if (action == "fs.move") {
        res = svc.moveIntent(payload);
    } else {
        res = json::object({{"ok", false}, {"error", json::object({{"code", "ENOSYS"}, {"message", "Unsupported admin action"}})}, {"action", action}});
    }

    std::cout << res.dump();
    return res.value("ok", false) ? 0 : 1;
}

int main(int argc, char **argv) {
    if (argc > 1 && argv[1] && std::string(argv[1]) == "--admin-fs") {
        return runAdminFsMode(argc, argv);
    }

    fs::path workspaceRoot;
    if (argc > 1) {
        workspaceRoot = fs::path(argv[1]);
    } else {
        workspaceRoot = fs::current_path();
    }

    std::string initialPath;
    if (argc > 2) {
        initialPath = argv[2];
    }

    std::string sessionToken;
    if (argc > 3) {
        sessionToken = argv[3];
    }

    fs::path executablePath;
#ifdef MMM_PLATFORM_LINUX
    try {
        executablePath = fs::canonical("/proc/self/exe");
    } catch (...) {
        executablePath = argv[0] ? fs::path(argv[0]) : fs::path();
    }
#else
    executablePath = argv[0] ? fs::path(argv[0]) : fs::path();
#endif

    MMMApp app(executablePath);
    return app.run(workspaceRoot, initialPath, sessionToken);
}
