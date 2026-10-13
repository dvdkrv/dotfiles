.PHONY: check

check:
	@set -e; \
	for f in dot_pi/**/*.json.tmpl; do \
		[ -e "$$f" ] || continue; \
		chezmoi execute-template --source "$(CURDIR)" < "$$f" | jq -e . >/dev/null || { echo "broken: $$f" >&2; exit 1; }; \
		echo "ok: $$f"; \
	done
