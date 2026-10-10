import Foundation
import VMProbeCore

struct Arguments {
    var backend = "auto"
    var diskURL = URL(fileURLWithPath: ".agent-computer/vm-probe-disk", isDirectory: true)
    var json = false
}

func parseArguments() -> Arguments {
    var result = Arguments()
    var args = Array(CommandLine.arguments.dropFirst())
    while let arg = args.first {
        args.removeFirst()
        switch arg {
        case "--json": result.json = true
        case "--backend": if let value = args.first { result.backend = value; args.removeFirst() }
        case "--disk": if let value = args.first { result.diskURL = URL(fileURLWithPath: value); args.removeFirst() }
        case "--help", "-h":
            print("usage: vm-probe [--json] [--backend auto|fake] [--disk PATH]")
            exit(0)
        default: break
        }
    }
    return result
}

let arguments = parseArguments()
let backend: any VMProbeBackend = arguments.backend == "fake" ? VMProbeFactory.makeFake() : VMProbeFactory.makeDefault()
do {
    let report = try VMProbeRunner.run(backend: backend, diskURL: arguments.diskURL)
    let encoder = JSONEncoder()
    encoder.outputFormatting = arguments.json ? [.sortedKeys] : [.prettyPrinted, .sortedKeys]
    print(String(decoding: try encoder.encode(report), as: UTF8.self))
} catch {
    let payload: [String: String] = ["schemaVersion": "vm-probe.v1", "backend": backend.name,
                                      "verdict": "unsupported", "error": String(describing: error)]
    let data = try! JSONSerialization.data(withJSONObject: payload, options: arguments.json ? [.sortedKeys] : [.prettyPrinted, .sortedKeys])
    print(String(decoding: data, as: UTF8.self))
    exit(2)
}
