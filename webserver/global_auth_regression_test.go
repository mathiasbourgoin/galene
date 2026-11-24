package webserver

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/jech/galene/group"
)

func TestEmptyUserPasswordDoesNotGrantAdmin(t *testing.T) {
	dir, data := t.TempDir(), t.TempDir()
	if err := setupTest(dir, data); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "public.json"), []byte(`{"users":{"":{"password":"guest","permissions":"present"}}}`), 0600); err != nil {
		t.Fatal(err)
	}
	username := ""
	if isAdminOrExplicitPassword("public", "", group.ClientCredentials{Username: &username, Password: "guest"}) {
		t.Fatal("empty user's password granted administrative access")
	}
}

func TestFirstLocalPasswordCanBeSet(t *testing.T) {
	dir, data := t.TempDir(), t.TempDir()
	if err := setupTest(dir, data); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "local.json"), []byte(`{"users":{"alice":{"permissions":"present"}}}`), 0600); err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodPost, "/", strings.NewReader("new-password"))
	req.Header.Set("Content-Type", "text/plain")
	req.SetBasicAuth("root", "pw")
	rec := httptest.NewRecorder()
	passwordHandler(rec, req, "local", "alice", false)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("set password: %d %s", rec.Code, rec.Body.String())
	}
	pw, location, err := group.GetUserPassword("local", "alice")
	if err != nil || location != "local" {
		t.Fatalf("password location %q: %v", location, err)
	}
	if ok, err := pw.Match("new-password"); !ok || err != nil {
		t.Fatalf("password match: %v %v", ok, err)
	}
}
