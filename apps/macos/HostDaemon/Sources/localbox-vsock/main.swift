import Darwin
import Foundation

/// The darwin guest's socat: listens on vsock ports and hands each connection to a Unix socket, so the guest agent is
/// reached exactly as on Linux and outlives every host connection. Accepts only the host (CID 2), because any local
/// guest user could otherwise reach the agent.
///   localbox-vsock 1024=/var/run/localbox/agent.sock 1025=/var/run/localbox/control.sock
///   localbox-vsock echo /path/to.sock         (lab) an echo server behind a socket
///   localbox-vsock dial <port>                (lab) connect to this guest's own vsock port; prints refused|accepted

let arguments = Array(CommandLine.arguments.dropFirst())
signal(SIGPIPE, SIG_IGN)

func fail(_ message: String) -> Never { FileHandle.standardError.write(Data("localbox-vsock: \(message)\n".utf8)); exit(1) }

func vsockAddress(cid: UInt32, port: UInt32) -> sockaddr_vm {
    var address = sockaddr_vm(); address.svm_len = UInt8(MemoryLayout<sockaddr_vm>.size); address.svm_family = sa_family_t(AF_VSOCK); address.svm_cid = cid; address.svm_port = port
    return address
}

func unixAddress(_ path: String) -> sockaddr_un {
    var address = sockaddr_un(); address.sun_family = sa_family_t(AF_UNIX)
    withUnsafeMutableBytes(of: &address.sun_path) { buffer in _ = path.utf8CString.withUnsafeBytes { buffer.copyMemory(from: UnsafeRawBufferPointer(rebasing: $0.prefix(buffer.count - 1))) } }
    return address
}

/// Copies bytes one way until either side closes, then shuts both down so the other pump ends too.
func pump(_ from: Int32, _ to: Int32) {
    var buffer = [UInt8](repeating: 0, count: 256 * 1024)
    while true {
        let count = read(from, &buffer, buffer.count)
        if count <= 0 { break }
        var offset = 0
        while offset < count { let written = buffer.withUnsafeBytes { write(to, $0.baseAddress! + offset, count - offset) }; if written <= 0 { offset = -1; break }; offset += written }
        if offset < 0 { break }
    }
    shutdown(from, SHUT_RDWR); shutdown(to, SHUT_RDWR)
}

func connectUnix(_ path: String) -> Int32? {
    // The agent may be restarting (an update swaps its binary): retry for a minute, as socat's retry=600,interval=0.1.
    for _ in 0..<600 {
        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        var address = unixAddress(path)
        let result = withUnsafePointer(to: &address) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { connect(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) } }
        if result == 0 { return fd }
        close(fd); usleep(100_000)
    }
    return nil
}

func forward(port: UInt32, to path: String) {
    let listener = socket(AF_VSOCK, SOCK_STREAM, 0)
    guard listener >= 0 else { fail("vsock socket: \(String(cString: strerror(errno)))") }
    var address = vsockAddress(cid: VMADDR_CID_ANY, port: port)
    let bound = withUnsafePointer(to: &address) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(listener, $0, socklen_t(MemoryLayout<sockaddr_vm>.size)) } }
    guard bound == 0, listen(listener, 16) == 0 else { fail("vsock port \(port): \(String(cString: strerror(errno)))") }
    Thread.detachNewThread {
        while true {
            var peer = sockaddr_vm(); var length = socklen_t(MemoryLayout<sockaddr_vm>.size)
            let client = withUnsafeMutablePointer(to: &peer) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { accept(listener, $0, &length) } }
            if client < 0 { continue }
            guard peer.svm_cid == VMADDR_CID_HOST else { close(client); continue }
            Thread.detachNewThread {
                guard let agent = connectUnix(path) else { close(client); return }
                Thread.detachNewThread { pump(client, agent) }
                pump(agent, client)
                close(client); close(agent)
            }
        }
    }
}

func echo(at path: String) -> Never {
    unlink(path)
    try? FileManager.default.createDirectory(atPath: (path as NSString).deletingLastPathComponent, withIntermediateDirectories: true)
    let listener = socket(AF_UNIX, SOCK_STREAM, 0)
    var address = unixAddress(path)
    let bound = withUnsafePointer(to: &address) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(listener, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) } }
    guard bound == 0, listen(listener, 16) == 0 else { fail("echo \(path): \(String(cString: strerror(errno)))") }
    while true {
        let client = accept(listener, nil, nil)
        if client < 0 { continue }
        Thread.detachNewThread { pump(client, client); close(client) }
    }
}

switch arguments.first {
case "echo":
    guard arguments.count == 2 else { fail("usage: localbox-vsock echo <socket>") }
    echo(at: arguments[1])
case "dial":
    guard arguments.count == 2, let port = UInt32(arguments[1]) else { fail("usage: localbox-vsock dial <port>") }
    var cid: UInt32 = 0
    let probe = socket(AF_VSOCK, SOCK_STREAM, 0)
    _ = ioctl(probe, 0x4004_73D1, &cid) // IOCTL_VM_SOCKETS_GET_LOCAL_CID, _IOR('s', 209, uint32_t); a macro Swift can't import
    var address = vsockAddress(cid: cid, port: port)
    let result = withUnsafePointer(to: &address) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { connect(probe, $0, socklen_t(MemoryLayout<sockaddr_vm>.size)) } }
    if result != 0 { print("refused: \(String(cString: strerror(errno)))"); exit(0) }
    var byte: UInt8 = 0x41
    _ = write(probe, &byte, 1)
    var reply: UInt8 = 0
    print(read(probe, &reply, 1) == 1 ? "accepted" : "refused: closed by the forwarder")
default:
    let mappings = arguments.compactMap { argument -> (UInt32, String)? in
        let parts = argument.split(separator: "=", maxSplits: 1)
        guard parts.count == 2, let port = UInt32(parts[0]) else { return nil }
        return (port, String(parts[1]))
    }
    guard !mappings.isEmpty, mappings.count == arguments.count else { fail("usage: localbox-vsock <port>=<socket> …") }
    for (port, path) in mappings { forward(port: port, to: path) }
    while true { sleep(3600) }
}
