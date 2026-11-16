package observability

import (
	"context"
	"database/sql"
	"io"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/gin-gonic/gin"
	"github.com/router-for-me/CLIProxyAPI/v8/internal/logging"
	"github.com/router-for-me/CLIProxyAPI/v8/internal/pro/observability/internalusage"
	log "github.com/sirupsen/logrus"
)

const promptLimit = 1 << 20

// Estimate throughput from the same request timing used by monitoring.
// TTFT excludes initial waiting; missing stream timing falls back to total latency.
func calculateOutputTPS(event internalusage.Event) (*float64, string) {
	if event.LatencyMS == nil || *event.LatencyMS <= 0 || event.OutputTokens <= 0 {
		return nil, "unavailable"
	}
	elapsed := *event.LatencyMS
	kind := "total_estimate"
	if event.Stream && event.TTFTMS != nil && *event.TTFTMS >= 0 && *event.TTFTMS < elapsed {
		elapsed -= *event.TTFTMS
		kind = "stream_estimate"
	}
	value := float64(event.OutputTokens) * 1000 / float64(elapsed)
	return &value, kind
}

type promptCapture struct {
	io.ReadCloser
	service                                    *Service
	requestID                                  string
	capturedAt                                 int64
	output                                     strings.Builder
	token                                      strings.Builder
	quoted, escaped, suppress, truncated, done bool
	lastString, key, marker                    string
	media                                      string
	mediaStack                                 []string
}

func CapturePrompt(c *gin.Context) {
	if c.Request.Method != http.MethodPost || c.Request.Body == nil || !strings.Contains(c.GetHeader("Content-Type"), "application/json") {
		return
	}
	globalStateMu.RLock()
	service := globalService
	globalStateMu.RUnlock()
	if service == nil || !service.cfg.Enabled {
		return
	}
	id := logging.GetGinRequestID(c)
	if id == "" {
		id = logging.GetRequestID(c.Request.Context())
	}
	if id == "" {
		return
	}
	c.Request.Body = &promptCapture{ReadCloser: c.Request.Body, service: service, requestID: id, capturedAt: time.Now().UnixMilli()}
}

func (p *promptCapture) append(s string) {
	remaining := promptLimit - p.output.Len()
	if len(s) > remaining {
		s = s[:remaining]
		p.truncated = true
	}
	p.output.WriteString(s)
}

func isBase64(s string) bool {
	if len(s) < 256 {
		return false
	}
	for _, c := range s {
		if !(c >= 'A' && c <= 'Z' || c >= 'a' && c <= 'z' || c >= '0' && c <= '9' || c == '+' || c == '/' || c == '=' || c == '-' || c == '_') {
			return false
		}
	}
	return true
}

// Inspect JSON strings incrementally; never retain a full encoded attachment.
func (p *promptCapture) observe(data []byte) {
	for _, c := range data {
		if p.output.Len() >= promptLimit {
			p.truncated = true
			continue
		}
		if !p.quoted {
			if c == '"' {
				p.quoted = true
				p.token.Reset()
				p.suppress = false
				p.marker = "[img]"
				p.escaped = false
				continue
			}
			if c == '{' || c == '[' {
				p.mediaStack = append(p.mediaStack, p.media)
			}
			if c == '}' || c == ']' {
				if n := len(p.mediaStack); n > 0 {
					p.media = p.mediaStack[n-1]
					p.mediaStack = p.mediaStack[:n-1]
				}
			}
			if c == ':' {
				p.key = p.lastString
			}
			if c == ',' || c == '{' || c == '[' {
				p.key = ""
			}
			p.append(string(c))
			continue
		}
		if c == '"' && !p.escaped {
			token := p.token.String()
			if p.suppress {
				marker := p.marker
				p.append("\"" + marker + "\"")
				p.lastString = ""
			} else {
				p.append("\"" + token + "\"")
				p.lastString = token
				if p.key == "mime_type" || p.key == "mimeType" || p.key == "media_type" || p.key == "type" {
					if strings.Contains(token, "audio") {
						p.media = "[audio]"
					} else if strings.Contains(token, "image") || token == "base64" {
						p.media = "[img]"
					} else if strings.Contains(token, "application/") || strings.Contains(token, "file") {
						p.media = "[file]"
					}
				}
			}
			p.token.Reset()
			p.quoted = false
			p.key = ""
			continue
		}
		if !p.suppress {
			if p.token.Len() < promptLimit+1 {
				p.token.WriteByte(c)
			} else {
				p.truncated = true
			}
			token := p.token.String()
			if (p.key == "data" && p.media != "") || p.key == "base64" || p.key == "file_data" || p.key == "b64_json" || (strings.HasPrefix(token, "data:") && strings.Contains(token, ";base64,")) || (len(token) == 256 && isBase64(token)) {
				p.suppress = true
				if p.media != "" {
					p.marker = p.media
				}
				if p.key == "file_data" || strings.HasPrefix(token, "data:application/") {
					p.marker = "[file]"
				}
				if strings.HasPrefix(token, "data:audio/") {
					p.marker = "[audio]"
				}
			}
		}
		if p.escaped {
			p.escaped = false
		} else if c == '\\' {
			p.escaped = true
		}
	}
}

func (p *promptCapture) Read(b []byte) (int, error) {
	n, err := p.ReadCloser.Read(b)
	if n > 0 {
		p.observe(b[:n])
	}
	if err != nil {
		p.finish()
	}
	return n, err
}
func (p *promptCapture) Close() error { p.finish(); return p.ReadCloser.Close() }
func (p *promptCapture) finish() {
	if p.done {
		return
	}
	p.done = true
	if p.quoted {
		p.truncated = true
		if p.suppress {
			p.append("\"" + p.marker + "\"")
		} else {
			p.append("\"" + p.token.String())
		}
	}
	text := p.output.String()
	for !utf8.ValidString(text) && len(text) > 0 {
		text = text[:len(text)-1]
	}
	if text == "" {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	err := p.service.module.Run(ctx, func() error {
		tx, err := p.service.store.beginTx(ctx, nil)
		if err != nil {
			return err
		}
		defer tx.Rollback()
		_, err = tx.ExecContext(ctx, `insert or replace into request_prompts(request_id,captured_at_ms,content,truncated,size_bytes) values(?,?,?,?,?)`, p.requestID, p.capturedAt, text, boolToInt(p.truncated), len(text))
		if err != nil {
			return err
		}
		_, err = tx.ExecContext(ctx, `delete from request_prompts where request_id not in (select request_id from request_prompts order by captured_at_ms desc,request_id desc limit 50)`)
		if err != nil {
			return err
		}
		return tx.Commit()
	})
	if err != nil {
		log.WithError(err).Warn("failed to save request prompt")
	}
}

func (s *Server) handleRequestPrompt(c *gin.Context) {
	id := strings.TrimSpace(c.Query("request_id"))
	if id == "" {
		c.JSON(400, gin.H{"error": "request_id is required"})
		return
	}
	var content string
	var truncated, size int
	err := s.store.executor(c.Request.Context()).QueryRowContext(c.Request.Context(), `select content,truncated,size_bytes from request_prompts where request_id=?`, id).Scan(&content, &truncated, &size)
	if err == sql.ErrNoRows {
		c.JSON(404, gin.H{"error": "Prompt unavailable: only the newest 50 requests are retained."})
		return
	}
	if err != nil {
		c.JSON(500, gin.H{"error": "Unable to load prompt"})
		return
	}
	c.Header("Cache-Control", "no-store")
	c.JSON(200, gin.H{"request_id": id, "content": content, "truncated": truncated != 0, "size_bytes": size})
}
