MARKETPLACE := spider-claude-mods

.PHONY: update

# Refreshes the marketplace, then updates every plugin from it that is installed, in its own scope.
update:
	claude plugin marketplace update $(MARKETPLACE)
	@claude plugin list --json | node -e ' \
		const list = JSON.parse(require("fs").readFileSync(0, "utf8")); \
		for (const p of list) if (p.id.endsWith("@$(MARKETPLACE)")) console.log(p.id, p.scope); \
	' | while read -r id scope; do \
		echo "==> $$id ($$scope)"; \
		claude plugin update "$$id" --scope "$$scope" </dev/null || exit 1; \
	done
