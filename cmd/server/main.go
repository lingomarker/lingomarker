package main

import (
	"context"
	"errors"
	"fmt"
	"lingomarker/internal/auth"
	"lingomarker/internal/config"
	"lingomarker/internal/database"
	"lingomarker/internal/handlers"
	"lingomarker/internal/router"
	"lingomarker/internal/tlsgen"
	"lingomarker/internal/transcription"
	"log"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/google/uuid"
)

func main() {
	// --- Configuration ---
	cfgPath := "config.yaml"
	cfg, err := config.LoadConfig(cfgPath)
	if err != nil {
		log.Fatalf("Failed to load configuration from %s: %v", cfgPath, err)
	}
	log.Printf("Configuration loaded: Domain=%s, Address=%s, DB=%s", cfg.Server.Domain, cfg.Server.Address, cfg.Database.DSN)

	// --- TLS Certificates ---
	caCertPath := filepath.Join(cfg.Server.CertDir, "ca.crt")
	caKeyPath := filepath.Join(cfg.Server.CertDir, "ca.key")
	serverCertPath := filepath.Join(cfg.Server.CertDir, "server.crt")
	serverKeyPath := filepath.Join(cfg.Server.CertDir, "server.key")

	err = tlsgen.EnsureCerts(cfg.Server.CertDir, caCertPath, caKeyPath, serverCertPath, serverKeyPath, cfg.Server.Domain)
	if err != nil {
		log.Fatalf("Failed to ensure TLS certificates: %v", err)
	}

	// Provide CA certificate path info for user
	absCaCertPath, _ := tlsgen.GetCACertPath(cfg.Server.CertDir, caCertPath)
	if absCaCertPath != "" {
		fmt.Println("\n--- IMPORTANT ---")
		fmt.Printf("For HTTPS to work in your browser, you MUST trust the generated CA certificate:\n")
		fmt.Printf("  %s\n", absCaCertPath)
		fmt.Println("Consult your browser/OS documentation on how to import and trust a CA certificate.")
		fmt.Println("Restart your browser after trusting the certificate.")
		fmt.Print("-----------------\n\n")
	}

	// --- Database ---
	db, err := database.InitDB(cfg.Database.DSN)
	if err != nil {
		log.Fatalf("Failed to initialize database: %v", err)
	}
	defer db.Close()

	// --- Templates ---
	templates, err := handlers.LoadTemplates(cfg.Web.TemplateDir)
	if err != nil {
		log.Fatalf("Failed to load HTML templates: %v", err)
	}

	// --- Initialize Transcription Service ---
	transcriptionCfg := &transcription.Config{
		ModelName: "gemini-2.5-flash-preview-04-17", // Make this configurable later if needed
	}
	transcriptionSvc := transcription.NewService(transcriptionCfg)

	// --- Handlers ---
	webHandlers := &handlers.WebHandlers{DB: db, Cfg: cfg, Templates: templates}
	apiHandlers := &handlers.APIHandlers{DB: db, Cfg: cfg, TranscriptionSvc: transcriptionSvc}

	// --- Use the SimpleRouter ---
	mux := router.New()

	// Static files (optional, if needed)
	staticFs := http.FileServer(http.Dir(cfg.Web.StaticDir))
	mux.HandlePrefix("GET", "/static/", http.StripPrefix("/static/", staticFs))

	// Public Web Pages (No Auth Required)
	// Use Handle with method "GET" (or "" for any method if desired)
	mux.Handle("GET", "/login", http.HandlerFunc(webHandlers.HandleLoginPage))
	mux.Handle("POST", "/login", http.HandlerFunc(webHandlers.HandleLoginPage)) // Handle POST separately
	mux.Handle("GET", "/register", http.HandlerFunc(webHandlers.HandleRegisterPage))
	mux.Handle("POST", "/register", http.HandlerFunc(webHandlers.HandleRegisterPage))

	// Auth Middleware
	authMW := handlers.AuthMiddleware(db, cfg)

	// Authenticated Web Pages
	// Need to wrap handlers with middleware *before* passing to router
	mux.Handle("POST", "/logout", authMW(http.HandlerFunc(webHandlers.HandleLogout))) // Assuming logout is POST
	mux.Handle("GET", "/training", authMW(http.HandlerFunc(webHandlers.HandleTrainingPage)))
	mux.Handle("GET", "/settings", authMW(http.HandlerFunc(webHandlers.HandleSettingsPage)))
	mux.Handle("POST", "/settings", authMW(http.HandlerFunc(webHandlers.HandleSettingsPage)))
	mux.Handle("GET", "/podcasts/upload", authMW(http.HandlerFunc(webHandlers.HandlePodcastUploadPage)))
	mux.Handle("GET", "/podcasts", authMW(http.HandlerFunc(webHandlers.HandlePodcastListPage)))
	mux.HandlePrefix("GET", "/podcasts/play/", authMW(http.HandlerFunc(webHandlers.HandlePodcastPlayPage)))
	mux.Handle("GET", "/review", authMW(http.HandlerFunc(webHandlers.HandleReviewPage)))

	// Authenticated API Endpoints
	// Note: Register specific paths *before* prefixes if they might overlap
	mux.Handle("GET", "/api/session", authMW(http.HandlerFunc(apiHandlers.HandleSessionCheck)))
	mux.Handle("GET", "/api/data", authMW(http.HandlerFunc(apiHandlers.HandleGetData)))
	mux.Handle("POST", "/api/mark", authMW(http.HandlerFunc(apiHandlers.HandleMarkWord)))
	mux.Handle("GET", "/api/training/data", authMW(http.HandlerFunc(apiHandlers.HandleGetTrainingData)))
	mux.Handle("POST", "/api/import", authMW(http.HandlerFunc(apiHandlers.HandleImportData)))
	mux.Handle("GET", "/api/review", authMW(http.HandlerFunc(apiHandlers.HandleGetReviewData)))

	// Podcast API routes
	mux.Handle("POST", "/api/podcasts", authMW(http.HandlerFunc(apiHandlers.HandlePodcastUpload)))
	mux.Handle("GET", "/api/podcasts", authMW(http.HandlerFunc(apiHandlers.HandleListPodcasts)))
	// Handle DELETE /api/podcasts/{id} using HandlePrefix
	mux.HandlePrefix("DELETE", "/api/podcasts/", authMW(http.HandlerFunc(apiHandlers.HandleDeletePodcast)))
	// The handler will need to check the method and extract the param from context
	mux.HandlePrefix("GET", "/api/podcasts/", authMW(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// The router now extracts the *entire suffix* after /api/podcasts/
		pathSuffix := router.GetPathParam(r.Context()) // e.g., "{id}" or "{id}/play_data"

		if pathSuffix == "" {
			http.NotFound(w, r) // Should ideally not happen with prefix logic
			return
		}

		// Check if the suffix matches the pattern "{id}/play_data"
		if strings.HasSuffix(pathSuffix, "/play_data") {
			idOnly := strings.TrimSuffix(pathSuffix, "/play_data")
			if idOnly == "" {
				http.Error(w, "Missing podcast ID before /play_data", http.StatusBadRequest)
				return
			}
			// Validate ID format
			if _, err := uuid.Parse(idOnly); err != nil {
				http.Error(w, "Invalid podcast ID format in path", http.StatusBadRequest)
				return
			}
			// Overwrite context ONLY with the ID for the target handler
			ctxWithID := context.WithValue(r.Context(), router.PathParamContextKey, idOnly)
			apiHandlers.HandleGetPodcastPlayData(w, r.WithContext(ctxWithID)) // Call specific handler

		} else if !strings.Contains(pathSuffix, "/") { // Assume it's just "{id}"
			// Validate ID format
			if _, err := uuid.Parse(pathSuffix); err != nil {
				http.Error(w, "Invalid podcast ID format in path", http.StatusBadRequest)
				return
			}
			// Call handler for GET /api/podcasts/{id} when implemented
			http.Error(w, "GET /api/podcasts/{id} not implemented yet", http.StatusNotImplemented)

		} else {
			// Any other pattern like /api/podcasts/{id}/something/else
			http.NotFound(w, r)
		}
	})))

	// Add other prefix routes if needed, e.g., for GET /api/podcasts/{id}
	// mux.HandlePrefix("GET", "/api/podcasts/", authMW(http.HandlerFunc(apiHandlers.HandleGetPodcast))) // Example for later

	// Entry Deletion (Requires modification in handler to use GetPathParam)
	// Assuming /api/entries/{uuid}
	mux.HandlePrefix("DELETE", "/api/entries/", authMW(http.HandlerFunc(apiHandlers.HandleDeleteEntry))) // Use prefix

	// Root redirect (needs careful handling with method/path)
	// Simplest: Handle only GET for root redirect
	mux.Handle("GET", "/", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/" {
			// Check auth status *here* or rely on middleware redirection?
			// Let's assume if they reach here unauthenticated, they should go to login
			_, err := auth.GetUserIDFromRequest(r, db, cfg) // Reuse auth check helper
			if err != nil {
				http.Redirect(w, r, "/login", http.StatusFound)
			} else {
				http.Redirect(w, r, "/review", http.StatusFound) // Redirect logged-in users to review page
			}
		} else {
			// Let the router's default handle NotFound for other paths
			http.NotFound(w, r)
		}
	}))

	// --- File Server for Media ---
	// Serve files from the configured upload directory under the /media/ path
	// Ensure cfg.Storage.UploadDir is set correctly in your config
	uploadDir := cfg.Storage.UploadDir
	if uploadDir == "" {
		log.Println("Warning: cfg.Storage.UploadDir is not set. Media files may not serve.")
	} else {
		absUploadDir, err := filepath.Abs(uploadDir)
		if err != nil {
			log.Fatalf("Error getting absolute path for upload directory: %v", err)
		}
		log.Printf("Serving media files from %s under /media/", absUploadDir)
		// http.StripPrefix is important to map /media/path/to/file.mp3 to fs.Open("path/to/file.mp3")
		fileServer := http.FileServer(http.Dir(absUploadDir))
		mux.HandlePrefix("GET", "/media/", http.StripPrefix("/media/", fileServer))
	}

	/*
		// Root redirect
		mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
			if r.URL.Path == "/" {
				http.Redirect(w, r, "/review", http.StatusFound) // Redirect logged-in users to review page
			} else {
				// Handle 404 for other paths not matched
				http.NotFound(w, r)
			}
		})
	*/

	// Apply Global Middleware (Logging)
	loggedMux := handlers.LoggingMiddleware(mux)

	// --- Server ---
	server := &http.Server{
		Addr:         cfg.Server.Address,
		Handler:      loggedMux, // Use the middleware-wrapped mux
		ReadTimeout:  cfg.Server.Timeout,
		WriteTimeout: cfg.Server.Timeout,
		IdleTimeout:  cfg.Server.Timeout * 2,
	}

	// --- Graceful Shutdown ---
	go func() {
		log.Printf("Starting HTTPS server on %s", cfg.Server.Address)
		// Use generated certs
		if err := server.ListenAndServeTLS(serverCertPath, serverKeyPath); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Fatalf("ListenAndServeTLS error: %v", err)
		}
	}()

	// Wait for interrupt signal
	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
	<-quit
	log.Println("Shutting down server...")

	// Context for graceful shutdown
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	// Perform cleanup tasks (e.g., delete expired sessions)
	deletedSessions, err := db.DeleteExpiredSessions()
	if err != nil {
		log.Printf("Error cleaning up expired sessions: %v", err)
	} else if deletedSessions > 0 {
		log.Printf("Cleaned up %d expired sessions.", deletedSessions)
	}

	// Shutdown server
	if err := server.Shutdown(ctx); err != nil {
		log.Fatalf("Server forced to shutdown: %v", err)
	}

	log.Println("Server exiting.")
}
