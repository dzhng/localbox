// `swift create-efi-vars.swift <path>`: writes a fresh EFI variable store, the boot store of a Linux image. Only
// Virtualization writes the format; a fresh store is empty, so firmware boots the disk's removable path
// (/EFI/BOOT/BOOTAA64.EFI). Creating one needs no virtualization entitlement.
import Foundation
import Virtualization

guard CommandLine.arguments.count == 2 else {
    FileHandle.standardError.write(Data("usage: swift create-efi-vars.swift <path>\n".utf8))
    exit(64)
}
_ = try VZEFIVariableStore(creatingVariableStoreAt: URL(fileURLWithPath: CommandLine.arguments[1]))
