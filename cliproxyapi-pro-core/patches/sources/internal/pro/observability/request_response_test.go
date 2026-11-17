package observability

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/router-for-me/CLIProxyAPI/v8/internal/logging"
)

func TestResponseCapturePassthroughPersistenceAndEviction(t *testing.T) {
	store, err := OpenStore(filepath.Join(t.TempDir(), "usage.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	svc := &Service{store: store, module: New(), cfg: Config{Enabled: true}}
	SetDefaultService(svc)
	defer SetDefaultService(nil)
	recorder := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(recorder)
	c.Request = httptest.NewRequest("POST", "/v1/chat/completions", strings.NewReader(`{"model":"test","messages":[{"role":"user","content":"q"}]}`))
	c.Request.Header.Set("Content-Type", "application/json")
	logging.SetGinRequestID(c, "roundtrip")
	CapturePrompt(c)
	_, _ = io.ReadAll(c.Request.Body)
	finish := CaptureResponse(c)
	c.Header("Content-Type", "text/event-stream")
	chunk1 := "data: {\"choices\":[{\"delta\":{\"content\":\"hello\"}}]}\n\n"
	chunk2 := "data: {\"choices\":[{\"delta\":{\"content\":\" world\"}}]}\n\ndata: [DONE]\n\n"
	_, _ = c.Writer.WriteString(chunk1)
	c.Writer.Flush()
	_, _ = c.Writer.Write([]byte(chunk2))
	finish()
	if recorder.Body.String() != chunk1+chunk2 || !recorder.Flushed {
		t.Fatal("stream changed or flush lost")
	}
	var response, state string
	if err = store.db.QueryRow(`select response_content,response_state from request_prompts where request_id='roundtrip'`).Scan(&response, &state); err != nil || response != chunk1+chunk2 || state != "complete" {
		t.Fatal("saved stream", state, err)
	}
	_, _ = store.db.Exec(`delete from request_prompts where request_id='roundtrip'`)
	finish()
	var count int
	_ = store.db.QueryRow(`select count(*) from request_prompts`).Scan(&count)
	if count != 0 {
		t.Fatal("evicted prompt resurrected")
	}
}

func TestResponseCaptureStatusMediaAndLimits(t *testing.T) {
	store, err := OpenStore(filepath.Join(t.TempDir(), "usage.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	svc := &Service{store: store, module: New(), cfg: Config{Enabled: true}}
	SetDefaultService(svc)
	defer SetDefaultService(nil)
	cases := []struct {
		name, content, ctype, state string
		status                      int
		cancel                      bool
	}{
		{"plain", `{"choices":[{"message":{"content":"answer"}}]}`, "application/json", "complete", 200, false},
		{"media", `{"data":[{"b64_json":"` + strings.Repeat("A", 2<<20) + `"}],"text":"useful"}`, "application/json", "complete", 200, false},
		{"truncated", `{"text":"` + strings.Repeat("useful ", promptLimit) + `"}`, "application/json", "truncated", 200, false},
		{"incomplete", "data: {\"choices\":[{\"delta\":{\"content\":\"partial\"}}]}\n\n", "text/event-stream", "incomplete", 200, false},
		{"error", `{"error":{"message":"upstream failed"}}`, "application/json", "error", 502, false},
		{"cancel", "data: {\"choices\":[{\"delta\":{\"content\":\"partial\"}}]}\n\n", "text/event-stream", "interrupted", 200, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := store.db.Exec(`insert into request_prompts(request_id,captured_at_ms,content,truncated,size_bytes) values(?,1,'{}',0,2)`, tc.name)
			if err != nil {
				t.Fatal(err)
			}
			recorder := httptest.NewRecorder()
			c, _ := gin.CreateTestContext(recorder)
			c.Request = httptest.NewRequest("POST", "/v1/chat/completions", nil)
			c.Request.Header.Set("Content-Type", "application/json")
			logging.SetGinRequestID(c, tc.name)
			ctx, cancel := context.WithCancel(c.Request.Context())
			defer cancel()
			c.Request = c.Request.WithContext(ctx)
			finish := CaptureResponse(c)
			c.Header("Content-Type", tc.ctype)
			c.Status(tc.status)
			_, _ = c.Writer.WriteString(tc.content)
			if tc.cancel {
				cancel()
			}
			finish()
			var content, state string
			var status int
			if err = store.db.QueryRow(`select response_content,response_state,response_status from request_prompts where request_id=?`, tc.name).Scan(&content, &state, &status); err != nil {
				t.Fatal(err)
			}
			if state != tc.state || status != tc.status || len(content) > promptLimit {
				t.Fatal(state, status, len(content))
			}
			if tc.name == "media" && (!strings.Contains(content, "[img]") || strings.Contains(content, "AAAA") || !strings.Contains(content, "useful")) {
				t.Fatal("media not removed")
			}
			if recorder.Body.String() != tc.content {
				t.Fatal("downstream content changed")
			}
		})
	}
	req := httptest.NewRequest(http.MethodGet, "/usage/prompt?request_id=plain", nil)
	c, _ := gin.CreateTestContext(httptest.NewRecorder())
	c.Request = req
	NewServer(Config{}, store).handleRequestPrompt(c)
}
