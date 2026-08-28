import Foundation

extension OpenClawChatViewModel {
    var hasActiveRunForComposerSettings: Bool {
        self.pendingRunCount > 0 || self.hasAdvertisedLiveRun ||
            self.hasActiveSessionRunWithoutChatSnapshot
    }

    public func selectThinkingLevel(_ level: String) {
        guard self.composerEffortMutationAvailable else { return }
        self.performSelectThinkingLevel(level)
    }

    public func selectVerboseLevel(_ level: String) {
        guard self.composerEffortMutationAvailable else { return }
        self.performSelectVerboseLevel(level)
    }

    public func selectFastMode(_ selectionID: String) {
        guard self.composerEffortMutationAvailable else { return }
        self.performSelectFastMode(selectionID)
    }

    var supportsComposerCapabilities: Bool {
        self.transport.supportsComposerCapabilities
    }

    var composerCapabilityOwnerID: String {
        let target = self.currentModelPatchTarget()
        return [
            target.canonicalSessionKey,
            target.agentID ?? "",
            target.sessionRoutingContract ?? "",
            self.composerCapabilitySessionID ?? "",
        ].joined(separator: "\u{1f}")
    }

    private var composerCapabilitySessionID: String? {
        let live = self.sessionId?.trimmingCharacters(in: .whitespacesAndNewlines)
        if let live, !live.isEmpty { return live }
        let stored = self.currentSessionEntry()?.sessionId?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return stored?.isEmpty == false ? stored : nil
    }

    private var composerCapabilityOwnerMatches: Bool {
        self.composerCapabilityState.ownerID == self.composerCapabilityOwnerID
    }

    var composerCapabilityCatalog: OpenClawChatComposerCapabilityCatalog {
        self.composerCapabilityOwnerMatches
            ? self.composerCapabilityState.catalog
            : OpenClawChatComposerCapabilityCatalog()
    }

    var composerCapabilityControlsAvailable: Bool {
        self.composerCapabilityCatalog.sessionSettingsAvailable
    }

    var composerModelMutationAvailable: Bool {
        !self.supportsComposerCapabilities || self.composerCapabilityCatalog.modelMutationAvailable
    }

    var composerEffortMutationAvailable: Bool {
        !self.supportsComposerCapabilities || self.composerCapabilityCatalog.effortMutationAvailable
    }

    var composerCapabilitiesLoading: Bool {
        self.composerCapabilityOwnerMatches && self.composerCapabilityState.phase == .loading
    }

    var composerCapabilitiesFailed: Bool {
        self.composerCapabilityOwnerMatches && self.composerCapabilityState.phase == .failed
    }

    var composerCapabilityMutationDisabled: Bool {
        !self.composerCapabilityOwnerMatches || !self.composerCapabilityControlsAvailable ||
            self.composerCapabilityState.phase != .loaded ||
            self.composerCapabilityState.isMutating || self.isUpdatingSessionSettings
    }

    var composerCapabilityNotice: String? {
        self.composerCapabilityOwnerMatches ? self.composerCapabilityState.notice : nil
    }

    var composerCapabilityErrorMessage: String? {
        self.composerCapabilityOwnerMatches ? self.composerCapabilityState.errorMessage : nil
    }

    var composerPermissionMutationDisabledReason: String? {
        if !self.composerCapabilityOwnerMatches || self.composerCapabilitiesLoading {
            return String(localized: "Loading composer capabilities.")
        }
        if !self.composerCapabilityControlsAvailable {
            return String(localized: "Session capability controls require a newer Gateway.")
        }
        if self.composerCapabilityMutationDisabled {
            return String(localized: "Saving session settings.")
        }
        if !self.composerCapabilityCatalog.permissionMutationAvailable {
            return String(localized: "Changing permissions requires operator.write or operator.admin access.")
        }
        return nil
    }

    var composerToolOverrideMutationDisabledReason: String? {
        if !self.composerCapabilityOwnerMatches || self.composerCapabilitiesLoading {
            return String(localized: "Loading composer capabilities.")
        }
        if !self.composerCapabilityControlsAvailable {
            return String(localized: "Session capability controls require a newer Gateway.")
        }
        if self.composerCapabilityMutationDisabled {
            return String(localized: "Saving session settings.")
        }
        if !self.composerCapabilityCatalog.toolOverrideMutationAvailable {
            return String(localized: "Session tool controls require operator.admin access.")
        }
        return nil
    }

    var composerToolOverrideMutationHint: String? {
        self.composerToolOverrideMutationDisabledReason
    }

    var composerWebSearchMutationDisabledReason: String? {
        if self.composerCapabilitiesLoading {
            return String(localized: "Loading composer capabilities.")
        }
        if !self.composerCapabilityCatalog.webSearchAvailable {
            return self
                .composerCapabilityErrorMessage ?? String(localized: "Web Search is unavailable on this Gateway.")
        }
        if !self.composerCapabilityCatalog.webSearchBaseEnabled {
            return String(localized: "Web Search is disabled in the Gateway configuration.")
        }
        return self.composerToolOverrideMutationDisabledReason
    }

    var composerWebSearchMutationHint: String? {
        self.composerWebSearchMutationDisabledReason
    }

    func composerPermissionDisabledReason(_ mode: OpenClawChatPermissionMode?) -> String? {
        if mode == .full, !self.composerCapabilityCatalog.canSelectFullPermission {
            return String(localized: "Full permission requires operator.admin access.")
        }
        return self.composerPermissionMutationDisabledReason
    }

    func composerSkillDisabledReason(_ skill: OpenClawChatComposerSkill) -> String? {
        if !skill.baseEnabled {
            return String(localized: "Disabled in the Gateway configuration.")
        }
        if skill.missingDependencies {
            return String(localized: "Missing dependencies.")
        }
        if skill.blocked {
            return String(localized: "Blocked by policy.")
        }
        return self.composerToolOverrideMutationDisabledReason
    }

    func composerSkillStatusMessage(_ skill: OpenClawChatComposerSkill) -> String? {
        if let disabledReason = self.composerSkillDisabledReason(skill) {
            return disabledReason
        }
        if skill.agentFiltered, self.composerToolOverrides.skills[skill.key] == nil {
            return String(localized: "Not enabled for this agent. Enable for this session.")
        }
        return nil
    }

    var composerClearToolOverridesDisabled: Bool {
        self.composerCapabilityMutationDisabled ||
            !self.composerCapabilityCatalog.toolOverrideMutationAvailable ||
            self.composerToolOverrides.isEmpty
    }

    func dismissComposerCapabilityNotice() {
        self.composerCapabilityState.notice = nil
    }

    var composerPermissionMode: OpenClawChatPermissionMode? {
        self.currentSessionEntry()?.permissionMode
    }

    var composerToolOverrides: OpenClawChatSessionToolOverrides {
        self.currentSessionEntry()?.toolOverrides ?? OpenClawChatSessionToolOverrides()
    }

    var composerWebSearchEnabled: Bool {
        self.composerCapabilityCatalog.webSearchAvailable &&
            (self.composerToolOverrides.webSearch ?? self.composerCapabilityCatalog.webSearchBaseEnabled)
    }

    func composerSkillEnabled(_ skill: OpenClawChatComposerSkill) -> Bool {
        guard skill.baseEnabled, !skill.missingDependencies, !skill.blocked else { return false }
        return self.composerToolOverrides.skills[skill.key] ?? (skill.baseEnabled && !skill.agentFiltered)
    }

    func composerConnectorEnabled(_ connector: OpenClawChatComposerConnector) -> Bool {
        self.composerToolOverrides.mcpServers[connector.name] ?? connector.baseEnabled
    }

    func composerToolEnabled(server: String, tool: String) -> Bool {
        if let entry = self.currentSessionEntry() {
            return !(entry.toolOverrides?.mcpToolsDeny[server]?.contains(tool) ?? false)
        }
        return self.composerCapabilityCatalog.connectors
            .first(where: { $0.name == server })?.tools
            .first(where: { $0.name == tool }).map { $0.baseEnabled && !$0.sessionDenied } ?? false
    }

    func loadComposerCapabilities(force: Bool = false) async {
        guard self.supportsComposerCapabilities else { return }
        let ownerID = self.composerCapabilityOwnerID
        if !force,
           self.composerCapabilityState.ownerID == ownerID,
           self.composerCapabilityState.phase == .loaded || self.composerCapabilityState.phase == .loading
        {
            return
        }
        self.composerCapabilityState.loadGeneration &+= 1
        let loadGeneration = self.composerCapabilityState.loadGeneration
        self.composerCapabilityState.ownerID = ownerID
        self.composerCapabilityState.phase = .loading
        self.composerCapabilityState.catalog = OpenClawChatComposerCapabilityCatalog()
        self.composerCapabilityState.notice = nil
        self.composerCapabilityState.errorMessage = nil
        let target = self.currentModelPatchTarget()
        let catalog = await self.transport.loadComposerCapabilityCatalog(
            sessionKey: target.canonicalSessionKey,
            agentID: target.agentID)
        guard self.composerCapabilityState.loadGeneration == loadGeneration,
              self.composerCapabilityOwnerID == ownerID,
              self.currentModelPatchTarget() == target
        else { return }
        self.composerCapabilityState.catalog = catalog
        self.composerCapabilityState.phase = catalog.permissionMutationAvailable ||
            catalog.skillsAvailable || catalog.connectorsAvailable || catalog.toolAccessAvailable
            ? .loaded
            : .failed
        if self.composerCapabilityState.phase == .failed {
            self.composerCapabilityState.errorMessage = String(localized: "Composer capabilities are unavailable.")
        } else {
            self.composerCapabilityState.errorMessage = catalog.loadFailureMessage
        }
    }

    func invalidateComposerCapabilities() {
        self.composerCapabilityState.loadGeneration &+= 1
        self.composerCapabilityState.mutationGeneration &+= 1
        self.composerCapabilityState.ownerID = ""
        self.composerCapabilityState.phase = .idle
        self.composerCapabilityState.catalog = OpenClawChatComposerCapabilityCatalog()
        self.composerCapabilityState.isMutating = false
        self.composerCapabilityState.notice = nil
        self.composerCapabilityState.errorMessage = nil
    }

    func selectComposerPermissionMode(_ mode: OpenClawChatPermissionMode?) {
        guard self.composerCapabilityControlsAvailable,
              self.composerCapabilityCatalog.permissionMutationAvailable
        else { return }
        guard mode != .full || self.composerCapabilityCatalog.canSelectFullPermission else { return }
        guard mode != self.composerPermissionMode else { return }
        self.performComposerCapabilityPatch(
            OpenClawChatSessionSettingsPatch(permissionMode: .some(mode)),
            permissionMode: .some(mode),
            toolOverrides: nil,
            notice: String(localized: "New permissions apply to the next run."))
    }

    func toggleComposerWebSearch() {
        guard self.composerCapabilityControlsAvailable,
              self.composerCapabilityCatalog.webSearchAvailable,
              self.composerCapabilityCatalog.webSearchBaseEnabled,
              self.composerCapabilityCatalog.toolOverrideMutationAvailable
        else { return }
        var next = self.composerToolOverrides
        let desired = !self.composerWebSearchEnabled
        next.webSearch = desired == self.composerCapabilityCatalog.webSearchBaseEnabled ? nil : desired
        self.patchComposerToolOverrides(next)
    }

    func toggleComposerSkill(_ skill: OpenClawChatComposerSkill) {
        guard self.composerCapabilityControlsAvailable,
              self.composerCapabilityCatalog.toolOverrideMutationAvailable,
              skill.baseEnabled, !skill.missingDependencies,
              !skill.blocked
        else { return }
        var next = self.composerToolOverrides
        let desired = !self.composerSkillEnabled(skill)
        let baseEnabled = skill.baseEnabled && !skill.agentFiltered
        if desired == baseEnabled {
            next.skills.removeValue(forKey: skill.key)
        } else {
            next.skills[skill.key] = desired
        }
        self.patchComposerToolOverrides(next)
    }

    func toggleComposerConnector(_ connector: OpenClawChatComposerConnector) {
        guard self.composerCapabilityControlsAvailable,
              self.composerCapabilityCatalog.toolOverrideMutationAvailable
        else { return }
        var next = self.composerToolOverrides
        let desired = !self.composerConnectorEnabled(connector)
        if desired == connector.baseEnabled {
            next.mcpServers.removeValue(forKey: connector.name)
        } else {
            next.mcpServers[connector.name] = desired
        }
        self.patchComposerToolOverrides(next)
    }

    func toggleComposerTool(server: String, tool: String) {
        guard self.composerCapabilityControlsAvailable,
              self.composerCapabilityCatalog.toolOverrideMutationAvailable
        else { return }
        var next = self.composerToolOverrides
        let connector = self.composerCapabilityCatalog.connectors.first { $0.name == server }
        let baseDenied = self.currentSessionEntry() == nil
            ? Set(connector?.tools.filter(\.sessionDenied).map(\.name) ?? [])
            : []
        var denied = Set(next.mcpToolsDeny[server] ?? baseDenied.sorted())
        if denied.contains(tool) {
            denied.remove(tool)
        } else {
            denied.insert(tool)
        }
        if denied == baseDenied {
            next.mcpToolsDeny.removeValue(forKey: server)
        } else {
            next.mcpToolsDeny[server] = denied.sorted()
        }
        self.patchComposerToolOverrides(next)
    }

    func clearComposerToolOverrides() {
        guard !self.composerClearToolOverridesDisabled else { return }
        self.performComposerCapabilityPatch(
            OpenClawChatSessionSettingsPatch(toolOverrides: .some(nil)),
            permissionMode: nil,
            toolOverrides: .some(nil),
            notice: String(localized: "Tool overrides will be cleared for the next run."))
    }

    private func patchComposerToolOverrides(_ overrides: OpenClawChatSessionToolOverrides) {
        let normalized = overrides.isEmpty ? nil : overrides
        self.performComposerCapabilityPatch(
            OpenClawChatSessionSettingsPatch(toolOverrides: .some(normalized)),
            permissionMode: nil,
            toolOverrides: .some(normalized),
            notice: String(localized: "Tool changes apply to the next run."))
    }

    private func performComposerCapabilityPatch(
        _ patch: OpenClawChatSessionSettingsPatch,
        permissionMode: OpenClawChatPermissionMode??,
        toolOverrides: OpenClawChatSessionToolOverrides??,
        notice: String?)
    {
        guard self.composerCapabilityOwnerMatches,
              self.composerCapabilityControlsAvailable,
              self.composerCapabilityState.phase == .loaded,
              !self.composerCapabilityState.isMutating
        else { return }
        guard let expectedSessionID = self.composerCapabilitySessionID else {
            self.composerCapabilityState.errorMessage = String(
                localized: "Refresh this thread before changing its capabilities.")
            return
        }
        let target = self.currentModelPatchTarget()
        let originalSessionKey = self.sessionKey
        let ownerID = self.composerCapabilityOwnerID
        let scopedPatch = patch.withExpectedSessionID(expectedSessionID)
        self.composerCapabilityState.mutationGeneration &+= 1
        let mutationGeneration = self.composerCapabilityState.mutationGeneration
        self.composerCapabilityState.isMutating = true
        self.composerCapabilityState.errorMessage = nil
        self.composerCapabilityState.notice = nil
        let requestID = self.reserveSessionSettingsRequest(for: target)
        self.enqueueSessionSettingsPatch(requestID: requestID, target: target) { [weak self] routeLease in
            guard let self else { return }
            defer {
                if self.composerCapabilityState.mutationGeneration == mutationGeneration {
                    self.composerCapabilityState.isMutating = false
                }
            }
            do {
                guard let routeLease else {
                    throw OpenClawChatTransportSendError.notDispatched
                }
                guard self.composerCapabilityState.mutationGeneration == mutationGeneration,
                      self.composerCapabilityOwnerID == ownerID,
                      self.composerCapabilitySessionID == expectedSessionID,
                      target == self.currentModelPatchTarget(),
                      self.sessionKey == originalSessionKey
                else { return }
                let result = try await routeLease.patchSessionSettings(
                    sessionKey: target.canonicalSessionKey,
                    agentID: target.agentID,
                    patch: scopedPatch)
                guard self.composerCapabilityState.mutationGeneration == mutationGeneration,
                      self.composerCapabilityOwnerID == ownerID,
                      self.composerCapabilitySessionID == expectedSessionID,
                      target == self.currentModelPatchTarget(),
                      self.sessionKey == originalSessionKey
                else { return }
                guard let index = self.sessionIndexForModelState(sessionKey: originalSessionKey) else { return }
                if let permissionMode {
                    self.sessions[index].permissionMode = result?.permissionMode ?? permissionMode
                }
                if let toolOverrides {
                    self.sessions[index].toolOverrides = result?.toolOverrides ?? toolOverrides
                }
                self.composerCapabilityState.notice = notice
            } catch {
                guard self.composerCapabilityState.mutationGeneration == mutationGeneration,
                      self.composerCapabilityOwnerID == ownerID,
                      self.composerCapabilitySessionID == expectedSessionID,
                      target == self.currentModelPatchTarget(),
                      self.sessionKey == originalSessionKey
                else { return }
                self.composerCapabilityState.errorMessage = error.localizedDescription
                self.errorText = error.localizedDescription
            }
        }
    }
}
