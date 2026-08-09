#!/usr/bin/env swift

import Foundation
import Security

let arguments = CommandLine.arguments
guard arguments.count == 4 else {
    FileHandle.standardError.write(Data("Usage: king-keychain <get|set|delete> <service> <account>\n".utf8))
    exit(64)
}

let command = arguments[1]
let service = arguments[2]
let account = arguments[3]

var query: [String: Any] = [
    kSecClass as String: kSecClassGenericPassword,
    kSecAttrService as String: service,
    kSecAttrAccount as String: account,
]

func fail(_ operation: String, _ status: OSStatus) -> Never {
    let detail = SecCopyErrorMessageString(status, nil) as String? ?? "OSStatus \(status)"
    FileHandle.standardError.write(Data("KING Keychain \(operation) failed: \(detail)\n".utf8))
    exit(1)
}

switch command {
case "get":
    query[kSecReturnData as String] = true
    query[kSecMatchLimit as String] = kSecMatchLimitOne
    var result: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &result)
    if status == errSecItemNotFound { exit(44) }
    guard status == errSecSuccess else { fail("read", status) }
    guard let secret = result as? Data else {
        FileHandle.standardError.write(Data("KING Keychain returned invalid data.\n".utf8))
        exit(1)
    }
    FileHandle.standardOutput.write(secret.base64EncodedData())
    FileHandle.standardOutput.write(Data("\n".utf8))

case "set":
    let encodedInput = FileHandle.standardInput.readDataToEndOfFile()
    guard
        let encoded = String(data: encodedInput, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines),
        !encoded.isEmpty,
        let secret = Data(base64Encoded: encoded)
    else {
        FileHandle.standardError.write(Data("KING Keychain input is invalid.\n".utf8))
        exit(65)
    }

    let protectedValues: [String: Any] = [
        kSecValueData as String: secret,
        kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
    ]
    let updateStatus = SecItemUpdate(query as CFDictionary, protectedValues as CFDictionary)
    if updateStatus == errSecItemNotFound {
        for (key, value) in protectedValues { query[key] = value }
        let addStatus = SecItemAdd(query as CFDictionary, nil)
        guard addStatus == errSecSuccess else { fail("write", addStatus) }
    } else if updateStatus != errSecSuccess {
        fail("write", updateStatus)
    }

case "delete":
    let status = SecItemDelete(query as CFDictionary)
    if status == errSecItemNotFound { exit(44) }
    guard status == errSecSuccess else { fail("delete", status) }

default:
    FileHandle.standardError.write(Data("Unknown KING Keychain command.\n".utf8))
    exit(64)
}
