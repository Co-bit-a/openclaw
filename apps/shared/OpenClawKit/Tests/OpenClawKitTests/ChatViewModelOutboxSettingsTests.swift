import Foundation
import OpenClawKit
import Testing
@testable import OpenClawChatUI

struct ChatViewModelOutboxSettingsTests {
    @Test func `background replay uses its command owned session settings`() async throws {
        let (store, _, databaseDirectory) = try makeOutboxStore()
        defer { try? FileManager.default.removeItem(at: databaseDirectory) }
        let expectation = OpenClawChatSessionSettingsExpectation(
            permissionMode: .guarded,
            toolOverrides: OpenClawChatSessionToolOverrides(webSearch: false))
        #expect(await store.enqueueCommand(outboxTestCommand(
            id: "background-settings",
            text: "use captured authority",
            createdAt: Date().timeIntervalSince1970,
            sessionKey: "background",
            expectedSessionSettings: expectation)))
        let transport = OutboxTestTransport(
            healthy: true,
            sessions: [
                outboxSessionEntry(key: "main", thinkingLevels: ["off"], permissionMode: .full),
                outboxSessionEntry(key: "background", thinkingLevels: ["off"], permissionMode: .guarded),
            ],
            supportsSessionSettingsCAS: true)
        let vm = await makeOutboxViewModel(transport: transport, outbox: store)

        await MainActor.run { vm.load() }
        try await waitUntil("background command dispatch") {
            await transport.state.sentMessages == ["use captured authority"]
        }

        #expect(await transport.state.sentSessionKeys == ["agent:main:background"])
        #expect(await transport.state.sentSessionSettings.count == 1)
        #expect(await transport.state.sentSessionSettings[0] == expectation)
    }

    @Test func `CAS gateway parks a legacy command without a settings expectation`() async throws {
        let (store, _, databaseDirectory) = try makeOutboxStore()
        defer { try? FileManager.default.removeItem(at: databaseDirectory) }
        #expect(await store.enqueueCommand(outboxTestCommand(
            id: "legacy-settings",
            text: "review before replay",
            createdAt: Date().timeIntervalSince1970)))
        let transport = OutboxTestTransport(
            healthy: true,
            sessions: [outboxSessionEntry(key: "main", thinkingLevels: ["off"])],
            supportsSessionSettingsCAS: true)
        let vm = await makeOutboxViewModel(transport: transport, outbox: store)

        await MainActor.run { vm.load() }
        try await waitUntil("legacy command parked") {
            await store.loadCommands().first?.status == .failed
        }

        #expect(await transport.state.sentMessages.isEmpty)
        #expect(await store.loadCommands().first?.lastError ==
            "Session settings were not captured; review and retry this message.")
    }

    @Test func `failed restrictive patch cannot release a later automatic flush`() async throws {
        let (store, _, databaseDirectory) = try makeOutboxStore()
        defer { try? FileManager.default.removeItem(at: databaseDirectory) }
        let fullAccess = OpenClawChatSessionSettingsExpectation(permissionMode: .full, toolOverrides: nil)
        #expect(await store.enqueueCommand(outboxTestCommand(
            id: "failed-restriction",
            text: "do not auto release",
            createdAt: Date().timeIntervalSince1970,
            expectedSessionSettings: fullAccess)))
        let patchRelease = DeleteGate()
        let patchStarted = DeleteGate()
        let transport = OutboxTestTransport(
            healthy: false,
            sessions: [outboxSessionEntry(key: "main", thinkingLevels: ["off"], permissionMode: .full)],
            supportsSessionSettingsCAS: true)
        let vm = await makeOutboxViewModel(transport: transport, outbox: store)
        await MainActor.run { vm.load() }
        try await waitUntil("outbox restore") {
            await MainActor.run { vm.hasRestoredOutboxMessages }
        }
        await MainActor.run {
            let target = vm.sessionSettingsPatchTarget(
                in: "main",
                canonicalSessionKey: "agent:main:main",
                agentID: "main",
                sessionRoutingContract: "per-sender|main|main")
            let requestID = vm.reserveSessionSettingsRequest(for: target)
            vm.enqueueSessionSettingsPatch(requestID: requestID, target: target) { [weak vm] _ in
                await patchStarted.open()
                await patchRelease.wait()
                guard let vm else { return }
                vm.capabilityPatchFailureRevisionsByTarget[target, default: 0] &+= 1
                vm.capabilityPatchFailureMessagesByTarget[target] = "Restriction was not saved."
            }
            vm.readySessionMetadataGeneration = vm.sessionMetadataGeneration
            vm.reconciledOutboxBranchScopes.insert(OpenClawChatOutboxScope(sessionKey: "main", agentID: "main"))
            vm.applyTransportHealth(true)
            vm.flushOutboxIfNeeded()
        }
        await patchStarted.wait()
        try await waitUntil("flush waits behind restriction") {
            await store.loadCommands().first?.status == .sending
        }
        #expect(await transport.state.sentMessages.isEmpty)
        await patchRelease.open()
        try await waitUntil("dependent row parked") {
            await store.loadCommands().first?.status == .failed
        }

        await MainActor.run { vm.flushOutboxIfNeeded() }
        try await Task.sleep(for: .milliseconds(50))
        #expect(await transport.state.sentMessages.isEmpty)
        #expect(await store.loadCommands().first?.lastError == "Restriction was not saved.")
    }
}
