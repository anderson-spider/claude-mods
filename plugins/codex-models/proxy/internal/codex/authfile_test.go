package codex

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// jwt builds an unsigned JWT carrying the given claims.
func jwt(claims string) string {
	encode := func(s string) string { return base64.RawURLEncoding.EncodeToString([]byte(s)) }
	return encode(`{"alg":"none"}`) + "." + encode(claims) + ".sig"
}

// accessToken builds an access token shaped like the real one: it carries its
// own expiry plus the account and plan.
func accessToken(expiresIn time.Duration, account, plan string) string {
	return jwt(fmt.Sprintf(
		`{"exp":%d,"https://api.openai.com/auth":{"chatgpt_account_id":%q,"chatgpt_plan_type":%q}}`,
		time.Now().Add(expiresIn).Unix(), account, plan))
}

func TestStoreNoticesAnExternalUpdate(t *testing.T) {
	dir := t.TempDir()
	store := NewStore(nil, StoreOptions{Dir: dir})
	if err := store.Save(&Token{AccessToken: "first"}); err != nil {
		t.Fatal(err)
	}
	first, _, err := store.Access(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	writeNative(t, store.NativePath(), Token{AccessToken: "replacement"}, 0o600)
	second, _, err := store.Access(context.Background())
	if err != nil || second == first || second != "replacement" {
		t.Fatalf("Access = %q, %v", second, err)
	}
}

func TestCredentialSymlinkIsRefusedForEveryOperation(t *testing.T) {
	for _, dangling := range []bool{false, true} {
		t.Run(fmt.Sprint(dangling), func(t *testing.T) {
			fake, client := newOAuthServer(t, 0)
			dir, targetDir := t.TempDir(), t.TempDir()
			target := filepath.Join(targetDir, "credential.json")
			if !dangling {
				writeNative(t, target, Token{AccessToken: "expired", RefreshToken: "secret", ExpiresAt: time.Now().Add(-time.Hour)}, 0o600)
			}
			before, _ := os.ReadFile(target)
			link := filepath.Join(dir, nativeFileName)
			if err := os.Symlink(target, link); err != nil {
				t.Fatal(err)
			}
			store := NewStore(client, StoreOptions{Dir: dir})
			if err := store.Check(); err == nil {
				t.Fatal("Check followed a link")
			}
			if _, err := store.Peek(); err == nil {
				t.Fatal("Peek read a link")
			}
			if store.Authenticated() {
				t.Fatal("linked credential advertised")
			}
			if _, _, err := store.Held(); err == nil {
				t.Fatal("Held read a link")
			}
			if _, _, err := store.Access(context.Background()); err == nil {
				t.Fatal("Access refreshed a link")
			}
			if err := store.Save(&Token{AccessToken: "replacement"}); err == nil {
				t.Fatal("Save overwrote a link")
			}
			if _, err := store.Remove(); err == nil {
				t.Fatal("Remove deleted a link")
			}
			after, err := os.ReadFile(target)
			if dangling && !os.IsNotExist(err) {
				t.Fatalf("dangling target created: %v", err)
			}
			if string(before) != string(after) {
				t.Fatal("target changed")
			}
			if info, err := os.Lstat(link); err != nil || info.Mode()&os.ModeSymlink == 0 {
				t.Fatal("credential link removed")
			}
			if fake.calls.Load() != 0 {
				t.Fatal("linked refresh token sent")
			}
		})
	}
}

func TestCredentialLinkReplacingCachedFileIsRefused(t *testing.T) {
	store := NewStore(nil, StoreOptions{Dir: t.TempDir()})
	if err := store.Save(&Token{AccessToken: "held"}); err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(t.TempDir(), "other.json")
	writeNative(t, target, Token{AccessToken: "other"}, 0o600)
	if err := os.Remove(store.NativePath()); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(target, store.NativePath()); err != nil {
		t.Fatal(err)
	}
	if _, _, err := store.Access(context.Background()); err == nil {
		t.Fatal("cache hid credential link")
	}
}

func TestNativeCredentialClaimsAndSerialization(t *testing.T) {
	access := accessToken(2*time.Hour, "native-account", "plus")
	id := jwt(`{"email":"user@example.test"}`)
	data, err := json.Marshal(Token{AccessToken: access, IDToken: id, RefreshToken: "native-refresh"})
	if err != nil {
		t.Fatal(err)
	}
	token, err := decodeNative(data)
	if err != nil {
		t.Fatal(err)
	}
	if token.AccountID != "native-account" || token.PlanType != "plus" || token.Email != "user@example.test" || token.Type != tokenType || !token.ExpiresAt.After(time.Now()) {
		t.Fatalf("native claims = %+v", token)
	}
	store := NewStore(nil, StoreOptions{Dir: t.TempDir()})
	if err := store.Save(token); err != nil {
		t.Fatal(err)
	}
	want, err := json.MarshalIndent(token, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	got, err := os.ReadFile(store.NativePath())
	if err != nil || string(got) != string(append(want, '\n')) {
		t.Fatalf("native serialization changed: %v", err)
	}
}

func TestNativeCredentialFileDoesNotDecodeCLILayout(t *testing.T) {
	fake, client := newOAuthServer(t, 0)
	store := NewStore(client, StoreOptions{Dir: t.TempDir()})
	body := `{"auth_mode":"chatgpt","tokens":{"access_token":"cli-access","refresh_token":"cli-refresh"}}`
	if err := os.WriteFile(store.NativePath(), []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, _, err := store.Access(context.Background()); !errors.Is(err, ErrNotAuthenticated) {
		t.Fatalf("CLI layout used: %v", err)
	}
	if fake.calls.Load() != 0 {
		t.Fatal("CLI refresh token sent")
	}
}
