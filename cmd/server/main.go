package main

import (
	"context"
	"errors"
	"fmt"
	"lingomarker/internal/config"
	"lingomarker/internal/database"
	"lingomarker/internal/handlers"
	"lingomarker/internal/tlsgen"
	"lingomarker/internal/transcription"
	"log"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"
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
		ModelName: "gemini-2.0-flash", // Make this configurable later if needed
	}
	transcriptionSvc := transcription.NewService(transcriptionCfg)

	// --- Handlers ---
	webHandlers := &handlers.WebHandlers{DB: db, Cfg: cfg, Templates: templates}
	apiHandlers := &handlers.APIHandlers{DB: db, Cfg: cfg, TranscriptionSvc: transcriptionSvc}

	// --- Router (using standard library mux) ---
	mux := http.NewServeMux()

	// Static files (optional, if needed)
	// staticFs := http.FileServer(http.Dir(cfg.Web.StaticDir))
	// mux.Handle("/static/", http.StripPrefix("/static/", staticFs))

	// Public Web Pages (No Auth Required)
	mux.HandleFunc("/login", webHandlers.HandleLoginPage)
	mux.HandleFunc("/register", webHandlers.HandleRegisterPage)

	// Auth Middleware
	authMW := handlers.AuthMiddleware(db, cfg)

	// Authenticated Web Pages
	mux.Handle("/logout", authMW(http.HandlerFunc(webHandlers.HandleLogout)))
	mux.Handle("/training", authMW(http.HandlerFunc(webHandlers.HandleTrainingPage)))
	mux.Handle("/settings", authMW(http.HandlerFunc(webHandlers.HandleSettingsPage)))
	mux.Handle("/podcasts/upload", authMW(http.HandlerFunc(webHandlers.HandlePodcastUploadPage)))

	// Authenticated API Endpoints
	apiRouter := http.NewServeMux() // Sub-router for API clarity
	apiRouter.Handle("/api/session", authMW(http.HandlerFunc(apiHandlers.HandleSessionCheck)))
	apiRouter.Handle("/api/data", authMW(http.HandlerFunc(apiHandlers.HandleGetData)))
	apiRouter.Handle("/api/mark", authMW(http.HandlerFunc(apiHandlers.HandleMarkWord)))
	apiRouter.Handle("/api/entries/", authMW(http.HandlerFunc(apiHandlers.HandleDeleteEntry))) // Note trailing slash for prefix match
	apiRouter.Handle("/api/training/data", authMW(http.HandlerFunc(apiHandlers.HandleGetTrainingData)))
	apiRouter.Handle("/api/import", authMW(http.HandlerFunc(apiHandlers.HandleImportData))) // Temporary Import
	apiRouter.Handle("/api/podcasts", authMW(http.HandlerFunc(apiHandlers.HandlePodcastUpload)))

	// Mount API router under /
	mux.Handle("/api/", apiRouter) // Handle requests starting with /api/

	// Root redirect
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/" {
			http.Redirect(w, r, "/training", http.StatusFound) // Redirect logged-in users to training
		} else {
			// Handle 404 for other paths not matched
			http.NotFound(w, r)
		}
	})

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
