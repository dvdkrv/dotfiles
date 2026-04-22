.PHONY: check

check:
	@set -e; \
	for f in dot_claude/*.json.tmpl dot_claude/**/*.json.tmpl; do \
		[ -e "$$f" ] || continue; \
		chezmoi execute-template < "$$f" | jq -e . >/dev/null || { echo "broken: $$f" >&2; exit 1; }; \
		echo "ok: $$f"; \
	done
