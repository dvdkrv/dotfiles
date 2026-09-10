# Add Mosh to Provisioned Packages

## Goal

Install Mosh on managed macOS and Linux machines so they can accept and initiate Mosh sessions after dotfiles provisioning.

## Design

Add `brew "mosh"` to `dot_Brewfile`, the repository's existing cross-platform Homebrew package manifest. The existing `run_onchange_before_01-install-packages.sh.tmpl` hash trigger will detect the manifest change and run `brew bundle` during the next Chezmoi apply.

No new provisioning script or platform-specific branch is needed because Homebrew supplies Mosh on both supported platforms, and the `mosh` package includes both client and server binaries.

## Verification

Run the repository test suite and checks that validate provisioning configuration. Confirm the diff contains only the design record and the intended Brewfile entry before committing and pushing the branch.
