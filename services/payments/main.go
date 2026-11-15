package main

import (
	"encoding/json"
	"net/http"
	"os"
	"runtime/debug"
	"strings"
)

// Orders at or above this amount are protected against double charging with the idempotency store.
const highValueCents = 10000

type server struct {
	gateway Gateway
	store   *Store
	retry   retryPolicy
	fake    *fakeGateway
}

type chargeRequest struct {
	OrderID        string `json:"orderId"`
	AmountCents    int    `json:"amountCents"`
	IdempotencyKey string `json:"idempotencyKey"`
}

func (s *server) handleCharge(w http.ResponseWriter, r *http.Request) {
	var req chargeRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.OrderID == "" || req.AmountCents <= 0 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "orderId and a positive amountCents are required"})
		return
	}

	protected := req.AmountCents >= highValueCents && req.IdempotencyKey != ""
	if protected {
		if prior, ok := s.store.Get(req.IdempotencyKey); ok {
			writeJSON(w, http.StatusOK, prior)
			return
		}
	}

	chargeID, err := chargeWithRetry(s.gateway, s.retry, req.OrderID, req.AmountCents)
	if err != nil {
		logError("charge failed for order %s: %v", req.OrderID, err)
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": "charge failed"})
		return
	}

	result := Result{ChargeID: chargeID, AmountCents: req.AmountCents}
	if protected {
		s.store.Put(req.IdempotencyKey, result)
	}
	writeJSON(w, http.StatusOK, result)
}

// handleChaos lets a demo switch the fake gateway's behaviour: {"mode":"unavailable"} or {"mode":"ok"}, or
// {"rotateKey":true} to make the gateway expect a new key (as if the provider had rotated it).
func (s *server) handleChaos(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Mode      string `json:"mode"`
		RotateKey bool   `json:"rotateKey"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "bad json"})
		return
	}
	if req.Mode == "ok" || req.Mode == "unavailable" {
		s.fake.mode.Store(req.Mode)
	}
	if req.RotateKey {
		s.fake.expectedKey.Store("sk_live_rotated_" + strings.Repeat("x", 12))
	}
	writeJSON(w, http.StatusOK, map[string]string{"mode": s.fake.mode.Load().(string)})
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

// recoverPanics keeps one bad request from killing the process, and logs it with its stack trace.
func recoverPanics(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			if rec := recover(); rec != nil {
				logAt("ERROR", "panic serving "+r.Method+" "+r.URL.Path+": "+toString(rec), "panic: "+toString(rec)+"\n\n"+string(debug.Stack()))
				writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
			}
		}()
		next.ServeHTTP(w, r)
	})
}

func toString(v any) string {
	switch t := v.(type) {
	case error:
		return t.Error()
	case string:
		return t
	default:
		b, _ := json.Marshal(t)
		return string(b)
	}
}

func newMux(s *server) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", func(w http.ResponseWriter, _ *http.Request) { writeJSON(w, http.StatusOK, map[string]bool{"ok": true}) })
	mux.HandleFunc("POST /charge", s.handleCharge)
	mux.Handle("POST /fake-gateway/charge", s.fake)
	if os.Getenv("CHAOS") == "1" {
		mux.HandleFunc("POST /_chaos", s.handleChaos)
	}
	return recoverPanics(mux)
}

func main() {
	addr := ":" + env("PORT", "8092")
	gatewayKey := env("GATEWAY_API_KEY", "sk_live_demo_0123456789abcdef")
	fake := newFakeGateway(env("FAKE_GATEWAY_EXPECTED_KEY", "sk_live_demo_0123456789abcdef"))
	s := &server{
		gateway: newHTTPGateway("http://127.0.0.1"+addr, gatewayKey),
		store:   NewStore(),
		retry:   defaultRetry(),
		fake:    fake,
	}
	logInfo("payments listening on %s", addr)
	if err := http.ListenAndServe(addr, newMux(s)); err != nil {
		logAt("FATAL", "payments stopped: "+err.Error(), "")
		os.Exit(1)
	}
}
