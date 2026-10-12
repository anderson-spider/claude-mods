package main

import (
	"context"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/signal"
	"syscall"

	"github.com/anderson-spider/claude-mods/plugins/codex-models/proxy/internal/codex"
	"github.com/anderson-spider/claude-mods/plugins/codex-models/proxy/internal/netx"
)

// runLogin signs in to a ChatGPT account through the browser (or a printed
// URL with --no-browser) and stores the credentials in the proxy's own file.
func runLogin(args []string) error {
	args, err := providerArg(args)
	if err != nil {
		return err
	}
	var noBrowser bool
	cfg, err := loadConfig("login", args, func(fs *flag.FlagSet) {
		fs.BoolVar(&noBrowser, "no-browser", false, "print the URL instead of opening a browser")
	})
	if err != nil {
		return err
	}

	// The token calls of a login go out directly, without serve's access log.
	oauth := codex.NewClient(&http.Client{Transport: netx.DirectTransport(), Timeout: outboundTimeout})
	store := codex.NewStore(oauth, storeOptions(cfg))

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	out := os.Stdout
	announce := func(authorizeURL string) {
		announceLogin(out, authorizeURL, codex.RedirectURI(codex.CallbackPort()), noBrowser)
	}
	result, err := oauth.Login(ctx, codex.CallbackPort(), !noBrowser, announce)
	if err != nil {
		return err
	}
	if err := store.Save(result.Token); err != nil {
		return err
	}
	fmt.Fprintf(out, "Signed in as %s (%s).\n", accountLabel(result.Token), planLabel(result.Token))
	fmt.Fprintf(out, "Credentials stored in %s\n", store.NativePath())
	return nil
}

// announceLogin tells the person where to authorize and where the callback
// is awaited.
func announceLogin(out io.Writer, authorizeURL, redirectURI string, noBrowser bool) {
	if noBrowser {
		fmt.Fprintln(out, "Open this URL to authorize the proxy:")
	} else {
		fmt.Fprintln(out, "Opening your browser. If nothing happens, open this URL:")
	}
	fmt.Fprintf(out, "\n  %s\n\n", authorizeURL)
	fmt.Fprintf(out, "Waiting for the callback on %s ...\n", redirectURI)
}

// runLogout removes the native credential file under the exclusive lock.
func runLogout(args []string) error {
	args, err := providerArg(args)
	if err != nil {
		return err
	}
	cfg, err := loadConfig("logout", args, nil)
	if err != nil {
		return err
	}
	out := os.Stdout
	removed, err := codex.NewStore(nil, storeOptions(cfg)).Remove()
	if err != nil {
		if os.IsNotExist(err) {
			fmt.Fprintln(out, "No Codex credentials were stored.")
			return nil
		}
		return err
	}
	fmt.Fprintf(out, "Removed %s\n", removed)
	return nil
}

// accountLabel names the signed-in account: its email, else its account id.
func accountLabel(token *codex.Token) string {
	switch {
	case token == nil:
		return "unknown account"
	case token.Email != "":
		return token.Email
	case token.AccountID != "":
		return token.AccountID
	}
	return "unknown account"
}

// planLabel names the account's ChatGPT plan.
func planLabel(token *codex.Token) string {
	if token == nil || token.PlanType == "" {
		return "plan unknown"
	}
	return token.PlanType + " plan"
}
