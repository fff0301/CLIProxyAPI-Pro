package observability

import (
	"context"
	"io"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/router-for-me/CLIProxyAPI/v8/internal/pro/observability/internalusage"
)

func TestPromptCaptureBoundedMediaAndPassthrough(t *testing.T) {
	store, err := OpenStore(filepath.Join(t.TempDir(), "usage.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	svc := &Service{store: store, module: New()}
	raw := `{"messages":[{"role":"user","content":[{"type":"text","text":"keep this useful text"},{"type":"image_url","image_url":{"url":"data:image/png;base64,` + strings.Repeat("A", 2<<20) + `"}}]}]}`
	p := &promptCapture{ReadCloser: io.NopCloser(strings.NewReader(raw)), service: svc, requestID: "media", capturedAt: 1}
	bytes, err := io.ReadAll(p)
	if err != nil || string(bytes) != raw {
		t.Fatal("request changed", err)
	}
	var content string
	var truncated int
	if err = store.db.QueryRow(`select content,truncated from request_prompts where request_id='media'`).Scan(&content, &truncated); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(content, "[img]") || !strings.Contains(content, "keep this useful text") || strings.Contains(content, "base64") || len(content) > 1024 {
		t.Fatal("media not sanitized", len(content))
	}
	if truncated != 0 {
		t.Fatal("sanitized media should not cause text truncation")
	}
	for i := 0; i < 60; i++ {
		p = &promptCapture{ReadCloser: io.NopCloser(strings.NewReader(`{"text":"hello"}`)), service: svc, requestID: time.Unix(int64(i), 0).String(), capturedAt: int64(i + 2)}
		_, _ = io.ReadAll(p)
	}
	var count int
	if err = store.db.QueryRow(`select count(*) from request_prompts`).Scan(&count); err != nil || count != 50 {
		t.Fatal("retention", count, err)
	}
	p = &promptCapture{ReadCloser: io.NopCloser(strings.NewReader(`{"text":"` + strings.Repeat("useful ", promptLimit) + `"}`)), service: svc, requestID: "large", capturedAt: 99}
	_, _ = io.ReadAll(p)
	if err = store.db.QueryRow(`select content,truncated from request_prompts where request_id='large'`).Scan(&content, &truncated); err != nil || len(content) > promptLimit || truncated != 1 {
		t.Fatal("size cap", len(content), truncated, err)
	}
}

func TestPromptNativeMediaPlaceholders(t *testing.T) {
	p := &promptCapture{}
	p.observe([]byte(`{"parts":[{"inline_data":{"mime_type":"audio/wav","data":"AQID"}},{"source":{"type":"base64","media_type":"image/png","data":"BAUG"}},{"data":"useful words"}]}`))
	got := p.output.String()
	if strings.Contains(got, "AQID") || strings.Contains(got, "BAUG") || !strings.Contains(got, "[audio]") || !strings.Contains(got, "[img]") || !strings.Contains(got, "useful words") {
		t.Fatal(got)
	}
}

func TestOutputTPSPersistence(t *testing.T) {
	store, err := OpenStore(filepath.Join(t.TempDir(), "usage.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	latency, ttft := int64(5000), int64(1000)
	e := internalusage.Event{EventHash: "speed-test", Timestamp: "2026-11-16T00:00:00Z", TimestampMS: 1, Model: "test", OutputTokens: 80, LatencyMS: &latency, TTFTMS: &ttft, Stream: true}
	if _, err = store.InsertLiveEvents(context.Background(), []internalusage.Event{e}); err != nil {
		t.Fatal(err)
	}
	events, err := store.RecentEvents(context.Background(), 1)
	if err != nil {
		t.Fatal(err)
	}
	if len(events) != 1 || events[0].OutputTPS == nil || *events[0].OutputTPS != 20 || events[0].OutputTPSKind != "stream_estimate" {
		t.Fatalf("bad speed: %+v", events)
	}
}
