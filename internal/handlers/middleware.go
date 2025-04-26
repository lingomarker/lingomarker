package handlers

import (
	"context"
	"lingomarker/internal/auth"
	"lingomarker/internal/config"
	"lingomarker/internal/database"
	"log"
	"net/http"
	"strings"
	"time"
)

// Context key type for user ID
type contextKey string

const UserIDContextKey = contextKey("userID")

// AuthMiddleware checks for a valid session and adds user ID to context
func AuthMiddleware(db *database.DB, cfg *config.Config) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			userID, err := auth.GetUserIDFromRequest(r, db, cfg)
			if err != nil {
				// For API requests, return 401 Unauthorized
				if strings.HasPrefix(r.URL.Path, "/api/") {
					log.Printf("AuthMiddleware: API access denied for %s: %v", r.RemoteAddr, err)
					http.Error(w, "Unauthorized: "+err.Error(), http.StatusUnauthorized)
					return
				}
				// For web pages, redirect to login
				log.Printf("AuthMiddleware: Web access redirect for %s: %v", r.RemoteAddr, err)
				http.Redirect(w, r, "/login?redirect="+r.URL.Path, http.StatusFound)
				return
			}

			// Add user ID to context
			ctx := context.WithValue(r.Context(), UserIDContextKey, userID)
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}

// LoggingMiddleware logs requests
func LoggingMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		// Use a custom ResponseWriter to capture status code
		rw := &responseWriter{ResponseWriter: w, statusCode: http.StatusOK} // Default to 200

		next.ServeHTTP(rw, r)

		log.Printf("%s %s %s %d %s", r.RemoteAddr, r.Method, r.URL.Path, rw.statusCode, time.Since(start))
	})
}

// responseWriter wraps http.ResponseWriter to capture status code
type responseWriter struct {
	http.ResponseWriter
	statusCode int
}

func (rw *responseWriter) WriteHeader(code int) {
	rw.statusCode = code
	rw.ResponseWriter.WriteHeader(code)
}

// Optional: Implement Write to capture size if needed
// func (rw *responseWriter) Write(b []byte) (int, error) {
//     // Capture size logic
//     return rw.ResponseWriter.Write(b)
// }
