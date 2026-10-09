MARKETPLACE := spider-claude-mods
PLUGINS := $(notdir $(wildcard plugins/*))
CUA_NODE := /Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node

.PHONY: update validate test

# Refreshes the marketplace, then updates every plugin from it that is installed, in its own scope.
update:
	claude plugin marketplace update $(MARKETPLACE)
	@claude plugin list --json | node -e ' \
		const list = JSON.parse(require("fs").readFileSync(0, "utf8")); \
		for (const p of list) if (p.id.endsWith("@$(MARKETPLACE)")) console.log(p.id, p.scope); \
	' | while read -r id scope; do \
		echo "==> $$id ($$scope)"; \
		claude plugin update "$$id" --scope "$$scope" </dev/null || echo "skip: $$id (not in the marketplace?)"; \
	done

# Validates the marketplace, every plugin, and that the manifests agree.
validate:
	claude plugin validate .
	@for p in $(PLUGINS); do echo "==> $$p"; claude plugin validate plugins/$$p || exit 1; done
	node scripts/check-consistency.mjs

# Runs every plugin's tests, and the codex-computer-use helper's when the ChatGPT app's node is present.
test:
	@for p in $(PLUGINS); do echo "==> $$p"; claude plugin test plugins/$$p || exit 1; done
	@if [ -x "$(CUA_NODE)" ]; then \
		echo "==> codex-computer-use helper"; \
		"$(CUA_NODE)" --test plugins/codex-computer-use/helper/test/*.test.mjs; \
	else \
		echo "==> codex-computer-use helper: skipped, $(CUA_NODE) not found"; \
	fi
