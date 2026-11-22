import Darwin
import Foundation

/// The shared launch lock (specs/menu-bar-app, README "Names"), seen from the app. Every `localbox` command started
/// through the home command holds it shared for its whole life (`apps/macos/App/launcher/main.c`); Sparkle's patched
/// helper takes it exclusively while it replaces the bundle. The path is the Info.plist key
/// `LocalboxLaunchLockRelativePath` (copied from the launcher's source) under the account home Sparkle uses.
public struct LaunchLock: Sendable {
    public let path: String

    public init(path: String) { self.path = path }

    /// The bundle's own lock: its Info.plist key under `home` (`NSHomeDirectory()`, which Sparkle's installer is given).
    public init?(info: [String: Any], home: String = NSHomeDirectory()) {
        guard let relative = info["LocalboxLaunchLockRelativePath"] as? String, !relative.isEmpty, !relative.hasPrefix("/"),
              !relative.split(separator: "/").contains(where: { $0 == ".." || $0 == "." }) else { return nil }
        path = (home as NSString).appendingPathComponent(relative)
    }

    /// Creates the lock file the launcher would, before any update cycle: a private regular file this user owns, in
    /// private folders. Sparkle's helper refuses anything else, so a bad one is found now, not at install time.
    public func prepare() throws {
        let folder = (path as NSString).deletingLastPathComponent
        try FileManager.default.createDirectory(atPath: folder, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let descriptor = try open()
        close(descriptor)
    }

    /// Returns once no command holds the lock: a non-blocking exclusive try every `interval`, released at once, so a
    /// command that starts meanwhile is never refused by this wait. `waiting` is called once, when the first try
    /// finds a command running. Throws `CancellationError` once `cancelled` says so (the update was called off).
    public func waitUntilFree(interval: TimeInterval = 0.2, cancelled: () -> Bool = { false }, waiting: () -> Void) throws {
        let descriptor = try open()
        defer { close(descriptor) }
        var told = false
        while flock(descriptor, LOCK_EX | LOCK_NB) != 0 {
            guard errno == EWOULDBLOCK else { throw LaunchLockError("cannot take \(path): \(String(cString: strerror(errno)))") }
            if cancelled() { throw CancellationError() }
            if !told { told = true; waiting() }
            Thread.sleep(forTimeInterval: interval)
        }
        flock(descriptor, LOCK_UN)
    }

    private func open() throws -> Int32 {
        let descriptor = Darwin.open(path, O_CREAT | O_RDWR | O_NOFOLLOW | O_CLOEXEC, 0o600)
        guard descriptor >= 0 else { throw LaunchLockError("cannot open \(path): \(String(cString: strerror(errno)))") }
        var opened = stat(), named = stat()
        guard fstat(descriptor, &opened) == 0, (opened.st_mode & S_IFMT) == S_IFREG, opened.st_uid == getuid(), opened.st_nlink == 1,
              (opened.st_mode & 0o077) == 0, lstat(path, &named) == 0, named.st_dev == opened.st_dev, named.st_ino == opened.st_ino else {
            close(descriptor)
            throw LaunchLockError("\(path) is not a private file owned by this user")
        }
        return descriptor
    }
}

public struct LaunchLockError: Error, CustomStringConvertible, LocalizedError {
    public let description: String
    public init(_ description: String) { self.description = description }
    public var errorDescription: String? { description }
}
