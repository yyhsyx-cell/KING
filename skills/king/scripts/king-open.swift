#!/usr/bin/env swift

import AppKit
import Foundation

let encodedInput = FileHandle.standardInput.readDataToEndOfFile()
guard
    let encoded = String(data: encodedInput, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines),
    !encoded.isEmpty,
    let urlData = Data(base64Encoded: encoded),
    let urlText = String(data: urlData, encoding: .utf8),
    let url = URL(string: urlText),
    ["https", "http"].contains(url.scheme?.lowercased() ?? "")
else {
    FileHandle.standardError.write(Data("KING activation URL is invalid.\n".utf8))
    exit(65)
}

guard NSWorkspace.shared.open(url) else {
    FileHandle.standardError.write(Data("KING could not open the activation page.\n".utf8))
    exit(1)
}
