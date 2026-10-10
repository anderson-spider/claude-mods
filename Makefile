PLUGINS := $(notdir $(wildcard plugins/*))
CUA_NODE := /Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node

.PHONY: validate test

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
