# Changelog

## [1.6.1](https://github.com/StrandedTurtle/dockpull/compare/v1.6.0...v1.6.1) (2026-07-19)


### Bug Fixes

* don't cancel in-flight :latest builds on release-please's follow-up push ([047e6ef](https://github.com/StrandedTurtle/dockpull/commit/047e6efded0e5d14cf5bd55b8422b82b9c4d30ad))
* don't cancel in-flight :latest builds on release-please's follow-up push ([d7cf7dc](https://github.com/StrandedTurtle/dockpull/commit/d7cf7dcca1575498e56321d8aa86780554dd3b13))

## [1.6.0](https://github.com/StrandedTurtle/dockpull/compare/v1.5.2...v1.6.0) (2026-07-19)


### Features

* show layer age in prune table ([d570b1f](https://github.com/StrandedTurtle/dockpull/commit/d570b1f0628521f7290593a0eb8f3a467ee30e1e))
* show layer age in prune table ([822f82b](https://github.com/StrandedTurtle/dockpull/commit/822f82b7c9e2f738fe00b703ffaf3f392685f9ae))

## [1.5.2](https://github.com/StrandedTurtle/dockpull/compare/v1.5.1...v1.5.2) (2026-07-17)


### Bug Fixes

* clarify changelog empty-state for update-without-a-new-release ([#71](https://github.com/StrandedTurtle/dockpull/issues/71)) ([2c32e6a](https://github.com/StrandedTurtle/dockpull/commit/2c32e6ab32cefaf3a1a278494b80e501deecd9f4))
* **deps-dev:** bump vite in /client in the client-minor-patch group ([#70](https://github.com/StrandedTurtle/dockpull/issues/70)) ([3b6df68](https://github.com/StrandedTurtle/dockpull/commit/3b6df683df1ca543dd613fb2cb26b84e70c53963))

## [1.5.1](https://github.com/StrandedTurtle/dockpull/compare/v1.5.0...v1.5.1) (2026-07-16)


### Bug Fixes

* give Dependabot a fix() commit prefix so dependency bumps auto-release ([#68](https://github.com/StrandedTurtle/dockpull/issues/68)) ([ef9102a](https://github.com/StrandedTurtle/dockpull/commit/ef9102a6a0c8ca2c7dd573220ba2df2da4ecc0c0))

## [1.5.0](https://github.com/StrandedTurtle/dockpull/compare/v1.4.0...v1.5.0) (2026-07-16)


### Features

* prune dialog lists each image in a table with per-row exclude ([#66](https://github.com/StrandedTurtle/dockpull/issues/66)) ([5e3a2a6](https://github.com/StrandedTurtle/dockpull/commit/5e3a2a6a8418573e2f674386089c92b1a09d1326))

## [1.4.0](https://github.com/StrandedTurtle/dockpull/compare/v1.3.3...v1.4.0) (2026-07-15)


### Features

* name containers in prune summary; badge when cleanup is available ([#63](https://github.com/StrandedTurtle/dockpull/issues/63)) ([169375a](https://github.com/StrandedTurtle/dockpull/commit/169375a16aa340f88e012bb172fefbc266d09697))


### Bug Fixes

* stop relying on fetch-metadata for Dependabot auto-merge classification ([#64](https://github.com/StrandedTurtle/dockpull/issues/64)) ([c800f9e](https://github.com/StrandedTurtle/dockpull/commit/c800f9eccb112f72315481c5aa5ee526218080d1))

## [1.3.3](https://github.com/StrandedTurtle/dockpull/compare/v1.3.2...v1.3.3) (2026-07-15)


### Bug Fixes

* stop dependabot-auto-merge from showing a skipped check on every PR ([#58](https://github.com/StrandedTurtle/dockpull/issues/58)) ([cf3aca4](https://github.com/StrandedTurtle/dockpull/commit/cf3aca4ac79d8fc312296bde0144acb70b2f47c9))

## [1.3.2](https://github.com/StrandedTurtle/dockpull/compare/v1.3.1...v1.3.2) (2026-07-15)


### Bug Fixes

* use the PAT for auto-merge too, not just release-please's own commits ([#56](https://github.com/StrandedTurtle/dockpull/issues/56)) ([00c4efa](https://github.com/StrandedTurtle/dockpull/commit/00c4efa2743560a9973d0400fd1ece00993af7c9))

## [1.3.1](https://github.com/StrandedTurtle/dockpull/compare/v1.3.0...v1.3.1) (2026-07-15)


### Bug Fixes

* authenticate release-please with a PAT for real pull_request events ([#54](https://github.com/StrandedTurtle/dockpull/issues/54)) ([ae02ec9](https://github.com/StrandedTurtle/dockpull/commit/ae02ec9ccef473b4984fda5edb58f314ba920834))

## [1.3.0](https://github.com/StrandedTurtle/dockpull/compare/v1.2.0...v1.3.0) (2026-07-15)


### Features

* prune confirmation shows a real image summary; fix release CI gap ([#51](https://github.com/StrandedTurtle/dockpull/issues/51)) ([aa51548](https://github.com/StrandedTurtle/dockpull/commit/aa51548984edf99f4d91af67be90055bea8c7161))


### Bug Fixes

* pass --repo to gh pr merge in release-please auto-merge step ([#53](https://github.com/StrandedTurtle/dockpull/issues/53)) ([d52674f](https://github.com/StrandedTurtle/dockpull/commit/d52674fed24b18f192b0da3496fa516e1920192d))

## [1.2.0](https://github.com/StrandedTurtle/dockpull/compare/v1.1.0...v1.2.0) (2026-07-14)


### Features

* breaking-change alerts on updates + prune dangling images ([ef5dcb3](https://github.com/StrandedTurtle/dockpull/commit/ef5dcb37b11ab964be2af1c3efc70c92863aec40))
* breaking-change alerts on updates + prune dangling images ([#49](https://github.com/StrandedTurtle/dockpull/issues/49)) ([ef5dcb3](https://github.com/StrandedTurtle/dockpull/commit/ef5dcb37b11ab964be2af1c3efc70c92863aec40))
* flag breaking-change release notes on pending updates ([7f9b7a7](https://github.com/StrandedTurtle/dockpull/commit/7f9b7a7b8538924700abf0ebf76ae4bb374eeeeb))
* prune dangling images from Settings ([647bcaa](https://github.com/StrandedTurtle/dockpull/commit/647bcaa61543eb118effb27da5cb8aaa5ea9de02))

## [1.1.0](https://github.com/StrandedTurtle/dockpull/compare/v1.0.2...v1.1.0) (2026-07-14)


### Features

* batch update summary, versions in history, app badge, search, state pills ([c814c7f](https://github.com/StrandedTurtle/dockpull/commit/c814c7fce20bc99bc1a5e5201651d4f2a19cfca2))
* batch update summary, versions in history, app badge, search, state pills ([088a650](https://github.com/StrandedTurtle/dockpull/commit/088a650e950ca300b84a8b1be46205d80b4efe87))
* batch update summary, versions in history, app badge, search, state pills ([#46](https://github.com/StrandedTurtle/dockpull/issues/46)) ([c814c7f](https://github.com/StrandedTurtle/dockpull/commit/c814c7fce20bc99bc1a5e5201651d4f2a19cfca2))
