# Sharing Builds and Libraries

Date: 2026-09-09

Subsequent user decision: sharing must never redistribute model files, regardless of license. The asset-bundling recommendation below is superseded by [the references-only specification](../../docs/reference-sharing.md). Keep this research as historical context, not the implementation contract.

Code baseline: `7fb93fb73be98e8f5989a772221180d7cb52e1c5`. Research and source review only; no product behavior changed.

## Question

How should PrintPartner users share Builds and Libraries, both within one installation and between installations?

## Recommendation

Make a published, versioned copy the first sharing product. A recipient previews it, sees which model files and dependencies are available, then chooses **Create my Build** or **Add to my Libraries**. The resulting copy belongs to the recipient. Preserve its origin and published revision, and offer explicit updates later. Treat permission to edit the original as a separate collaboration feature.

Start with reliable sharing on one installation and downloadable packages for transfer between installations. Add recipient-accessible links after the access model is explicit. A hosted community catalog and federation should follow demonstrated demand. These are proposals for PrintPartner, informed by the sources below, not claims about existing behavior or measured user preferences.

## Existing implementation

These findings come from source inspection in this workspace, not a live security test.

- Build sharing already creates a Kit JSON snapshot. The create route requires a session and multi-user mode. Acceptance imports a copy and then marks the share accepted. See [share routes](../../web/apps/server/src/routes/shares.ts).
- A share with no recipient appears in other users' incoming-share lists. Its accepted state belongs to the share globally. This does not implement an unlisted bearer link or a reusable publication with a separate receipt for each recipient. The inspected share lifecycle has no expiry. See [share persistence and queries](../../web/apps/server/src/services/auth-store.ts).
- Kit version 3 exports a ZIP containing `kit.json`, without the model file bytes. Existing export therefore transfers a recipe that depends on available Sources. It is not a complete portable model package. See [Kit export](../../web/apps/server/src/services/export-kit.ts).
- Kit import resolves a Source by name before URL, can update the matched Source's import rules, and reports unmatched Sources rather than acquiring the missing files. Same-name Sources can therefore represent different content. See `importKitBundle` in [repository](../../web/apps/server/src/db/repository.ts).
- Existing [share dialog](../../web/apps/web/src/components/share/ShareBuildExportDialog.tsx) and [incoming shares card](../../web/apps/web/src/components/share/IncomingSharesCard.tsx) provide useful entry points. The current implementation should not be presented as complete Library publication or cross-installation sharing.

## Evidence from established products

Onshape distinguishes public documents, link sharing, and named collaborators. A public document can be copied for editing. Link viewing can work without an account, and exporting through that link is a separate option. Named permissions distinguish viewing, editing, copying, exporting, resharing, and deletion. This supports separate controls for audience and allowed actions. It does not establish that anonymous access is right for every PrintPartner installation. See [Onshape sharing](https://cad.onshape.com/help/Content/Collaboration/share_documents.htm).

Onshape also distinguishes mutable workspaces from immutable versions and uses version references when linking documents. For PrintPartner, a published Build should resolve to a particular Library revision so a later Library edit cannot silently change its parts. See [Onshape linking documents](https://cad.onshape.com/help/Content/Document/linking_documents.htm).

GitHub distinguishes creating a new project from a template from forking an existing project's history. Templates start a new history; forks preserve the parent's history and can support contributions back. PrintPartner's first action should read **Create my Build**, with provenance retained. Calling that action **Fork** would imply update and contribution behavior that would need a separate design. See [GitHub repository templates](https://docs.github.com/en/repositories/creating-and-managing-repositories/creating-a-repository-from-a-template).

Nextcloud offers both public links and named shares. Links can have passwords and expiration dates. Federated sharing uses a remote user's identity and server address, with acceptance on the receiving side. Federation is a useful later precedent, but it requires a remote identity and server interaction model beyond copying a URL. See [Nextcloud file sharing](https://docs.nextcloud.com/server/latest/user_manual/en/files/sharing.html).

## Proposed experience

Place **Share** on both Build and Library detail pages. First show what will be shared and which published revision the recipient will receive. Offer a preview with the same content the recipient can access. An unpublished edit should not change an existing published revision.

| Audience | Who can open it | Discovery | Suitable use |
| --- | --- | --- | --- |
| Private | Owner and existing authorized members | Owner's workspace | Default before sharing |
| Invited people | Specified authenticated accounts | Their shared-with-me list | Handoff to a colleague |
| Anyone with the link | Anyone holding the link, subject to optional password or expiry | No catalog or global incoming list | Sending a reusable example |
| Public | Anyone able to reach the publication service | Explicit catalog/search listing | Community distribution |

These are proposed semantics. Audience is separate from permission to download or create a copy. An unlisted link can be forwarded, so it cannot promise named-recipient confidentiality. Use invited access when identity matters. Avoid anonymous edit links in the first release.

A Build preview should show a description, required parts and quantities, variant choices, source revisions, model availability, and applicable license information. Its copy should start with fresh production progress and no printer assignments. The recipient chooses their own printers. Exclude credentials, private paths, user identities, and production history from the publication payload.

A Library preview should show its useful contents, file availability, source origins, revisions, and licenses. Allow sharing selected content. Sharing the whole Library should capture a collection snapshot, not export an account or database. Including future additions should require a later, explicit subscription choice with visible scope. If **Library** currently means a local grouping of Sources rather than a standalone domain object, settle that boundary before introducing its publication schema.

On import, show dependencies as already available, available to acquire, or unavailable. Show downloads and license restrictions before committing the import. Missing model files must remain visible. The success message should not imply that a Build is ready for production when dependencies are absent.

## Proposed content and update model

Keep the publication distinct from its audience grants and recipient copies. A publication has an origin identifier and immutable revision. Its manifest identifies dependency origins, pinned revisions, file hashes, attribution, and available assets. Hashes verify content equality; they do not establish authorship or permission to redistribute it.

Do not match dependencies by display name. Use stable origin identity, revision, and content hashes. If an import needs different import rules, create or explicitly map its dependency rather than changing an existing Source used by other Builds.

A downloadable package should contain the manifest and redistributable assets. Where redistribution is unavailable, retain source links and describe what the recipient must obtain separately. Preserve compatibility checks and format versioning so import can fail with a useful explanation before changing workspace data.

Begin with independent copies and provenance. Later, show **Update available**, explain changed or removed parts, and let the recipient approve a new revision. Do not automatically rewrite active production work. Publishing must not introduce an approval gate into ordinary Build editing, printing, or progress tracking. A separate, explicit production handoff could preserve progress if users need it, while still excluding printer addresses, secrets, and customer or order details. Defer merge, contribution-back, and simultaneous editing until users need them.

For later collaboration, distinguish viewing, editing a recipe, recording Checkoff, and managing access. Sharing a Build must not grant access to the owner's whole Library or permission to control printers. Printer upload/start authorization remains separate from Build collaboration.

## Rights and revocation

Printables requires uploaders to have authority to distribute or license uploaded printing documents. PrintPartner should therefore capture rights per dependency instead of assuming ownership of a Build grants rights to every included model. Preserve existing source licenses and attribution; do not overwrite them with one Build-level license. See [Printables terms](https://www.prusa3d.com/page/terms-of-service-of-printables-com_231249/).

Revoking a share should stop future service access. It cannot remove copies that recipients already downloaded. Creative Commons states that compliant licensees retain rights after a licensor stops distributing the work. The interface must distinguish disabling a link from retracting already granted license rights. See [Creative Commons FAQ](https://creativecommons.org/faq/).

## Self-hosting and access control

A private LAN URL will not become internet-accessible because PrintPartner puts a token in it. RFC 1918 defines private addresses without global meaning. A recipient needs a route to the installation, such as the same network or an appropriately configured VPN, or a separately reachable publication service. See [RFC 1918](https://www.rfc-editor.org/rfc/rfc1918).

Keep package export/import available for offline and separate installations. For links, explain that recipients must be able to reach the server. A later hosted publication service could accept outbound uploads from private installations, but that introduces storage, retention, identity, moderation, and operating costs. It is a separate product decision.

OWASP recommends denying access by default and validating permissions on every request, including access to static resources. Apply the publication grant to previews, manifests, model files, and downloads. A protected page with a publicly accessible asset URL is insufficient. See [OWASP authorization guidance](https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html).

Treat imported packages and dependency URLs as untrusted input. Proposed import requirements include schema validation, archive path and expanded-size limits, candidate staging before activation, and validation of every remote redirect destination. Do not run imported G-code or send it to a printer as part of import. These are implementation requirements, not claims that the current sharing path already enforces them.

## Proposed delivery order and acceptance checks

1. Fix the current handoff semantics. Keep addressed invitations separate from reusable publications, add preview and dependency reporting, use safe dependency identity, and make import plus acceptance atomic or recoverably idempotent. Retrying an accepted invitation should return the same imported Build rather than create duplicates.
2. Deliver portable Build and Library packages with a versioned manifest, provenance, rights metadata, and permitted assets. Prove that a recipient installation with an empty catalog can import a complete package. A manifest-only package must clearly report what is missing.
3. Add reusable link publications with separate import receipts, revoke/rotate controls, optional expiry, and complete asset authorization. Keep public listing an explicit additional choice. An unlisted share must not enter everyone else's incoming list.
4. Add explicit revision updates if users repeatedly reuse published Libraries. Consider public discovery, cross-server invitations, and shared editing separately after observing actual demand.

Phase 1 tests should cover an addressed invitation opened by another account, a recipient-less share excluded from unrelated inboxes under the new semantics, two users independently importing one reusable publication, acceptance retried after an interrupted response, and an import failure that leaves no partial Build or consumed invitation. Dependency checks should prove that two same-name Sources do not match accidentally and that importing rules cannot mutate an existing Source. Revoked and expired access should fail for both the page and its assets when those lifecycle features land.

The main unresolved product question is whether users primarily want to hand a working Build to a colleague or distribute reusable content between independent installations. The proposed package and snapshot foundation supports both. Live collaboration has different permission and conflict requirements and should not be implied by the word **Share** alone.
