package observability

import (
	"context"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/gin-gonic/gin"
	"github.com/router-for-me/CLIProxyAPI/v8/internal/logging"
	log "github.com/sirupsen/logrus"
)

type responseCapture struct {
	gin.ResponseWriter
	body        promptCapture
	writeFailed bool
}

func (w *responseCapture) Write(b []byte) (int, error) {
	n, err := w.ResponseWriter.Write(b)
	if n > 0 {
		w.body.observe(b[:n])
	}
	if err != nil {
		w.writeFailed = true
	}
	return n, err
}
func (w *responseCapture) WriteString(s string) (int, error) { return w.Write([]byte(s)) }

// Capture only bytes delivered by the client-facing writer. Flush and optional
// interfaces remain delegated to Gin, so SSE delivery is never buffered here.
func CaptureResponse(c *gin.Context) func() {
	globalStateMu.RLock()
	svc := globalService
	globalStateMu.RUnlock()
	if svc == nil || !svc.cfg.Enabled || c.Request.Method != http.MethodPost || !strings.Contains(c.GetHeader("Content-Type"), "application/json") {
		return func() {}
	}
	id := logging.GetGinRequestID(c)
	if id == "" {
		id = logging.GetRequestID(c.Request.Context())
	}
	if id == "" {
		return func() {}
	}
	writer := &responseCapture{ResponseWriter: c.Writer}
	c.Writer = writer
	return func() {
		contentType := writer.Header().Get("Content-Type")
		if !strings.Contains(contentType, "json") && !strings.Contains(contentType, "event-stream") {
			return
		}
		p := &writer.body
		if p.quoted {
			p.truncated = true
			if p.suppress {
				p.append("\"" + p.marker + "\"")
			} else {
				p.append("\"" + p.token.String())
			}
		}
		content := p.output.String()
		for !utf8.ValidString(content) && len(content) > 0 {
			content = content[:len(content)-1]
		}
		state := "complete"
		if writer.Status() >= 400 {
			state = "error"
		} else if writer.writeFailed || c.Request.Context().Err() != nil {
			state = "interrupted"
		} else if p.truncated {
			state = "truncated"
		} else if strings.Contains(contentType, "event-stream") && !responseTerminal(content) {
			state = "incomplete"
		}
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		err := svc.module.Run(ctx, func() error {
			// UPDATE deliberately does not restore prompts evicted during long requests.
			_, err := svc.store.executor(ctx).ExecContext(ctx, `update request_prompts set response_content=?,response_type=?,response_status=?,response_truncated=?,response_state=? where request_id=?`, content, contentType, writer.Status(), boolToInt(p.truncated), state, id)
			return err
		})
		if err != nil {
			log.WithError(err).Warn("failed to save request response")
		}
	}
}

func responseTerminal(s string) bool {
	return strings.Contains(s, "[DONE]") || strings.Contains(s, "\"message_stop\"") || strings.Contains(s, "\"response.completed\"") || strings.Contains(s, "\"response.failed\"") || strings.Contains(s, "\"response.incomplete\"") || strings.Contains(s, "\"finishReason\"")
}
