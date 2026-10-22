.PHONY: check

check:
	@set -e; \
	for f in dot_pi/**/*.json.tmpl; do \
		[ -e "$$f" ] || continue; \
		chezmoi execute-template --source "$(CURDIR)" < "$$f" | jq -e . >/dev/null || { echo "broken: $$f" >&2; exit 1; }; \
		echo "ok: $$f"; \
	done; \
	home="$$(mktemp -d)"; trap 'rm -rf "$$home"' EXIT; \
	chezmoi --source "$(CURDIR)" --destination "$$home" cat "$$home/.pi/agent/settings.json" | jq -e . >/dev/null || { echo "broken: dot_pi/agent/modify_settings.json" >&2; exit 1; }; \
	echo "ok: dot_pi/agent/modify_settings.json"
