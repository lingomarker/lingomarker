package handlers

import (
	"fmt"
	"html/template"
	"lingomarker/internal/auth"
	"lingomarker/internal/config"
	"lingomarker/internal/database"
	"lingomarker/internal/models"
	"lingomarker/internal/router"
	"log"
	"net/http"
	"net/url"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/google/uuid"
)

type WebHandlers struct {
	DB        *database.DB
	Cfg       *config.Config
	Templates *template.Template
}

// LoadTemplates parses all templates in the specified directory
func LoadTemplates(templateDir string) (*template.Template, error) {
	// Ensure paths use correct separators
	cleanDir := filepath.Clean(templateDir)

	// Parse all html files including those in subdirectories (like partials)
	tmpl, err := template.ParseGlob(filepath.Join(cleanDir, "*.html"))
	if err != nil {
		return nil, err
	}
	// Parse partials if they exist
	partialsPath := filepath.Join(cleanDir, "partials", "*.html")
	if _, err := filepath.Glob(partialsPath); err == nil { // Check if glob pattern matches anything
		tmpl, err = tmpl.ParseGlob(partialsPath)
		if err != nil {
			return nil, err
		}
	} else if !strings.Contains(err.Error(), "no matching files found") {
		// Log unexpected glob errors, but continue if it's just no partials found
		log.Printf("Warning: Error checking for partial templates at %s: %v", partialsPath, err)
	}

	log.Printf("Loaded templates from %s", cleanDir)
	return tmpl, nil
}

// renderTemplate executes a specific template
func (h *WebHandlers) renderTemplate(w http.ResponseWriter, tmplName string, data interface{}) {
	err := h.Templates.ExecuteTemplate(w, tmplName, data)
	if err != nil {
		log.Printf("Error rendering template %s: %v", tmplName, err)
		// Provide a more user-friendly error page in production
		http.Error(w, "Internal Server Error", http.StatusInternalServerError)
	}
}

// --- Page Handlers ---

func (h *WebHandlers) HandleLoginPage(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodGet {
		// Check if already logged in, redirect if so
		_, err := auth.GetUserIDFromRequest(r, h.DB, h.Cfg)
		if err == nil {
			http.Redirect(w, r, "/review", http.StatusFound) // Redirect to review page
			return
		}

		data := map[string]interface{}{"Title": "Login", "Error": r.URL.Query().Get("error")}
		h.renderTemplate(w, "login.html", data)
		return
	}

	if r.Method == http.MethodPost {
		if err := r.ParseForm(); err != nil {
			http.Error(w, "Failed to parse form", http.StatusBadRequest)
			return
		}
		username := r.FormValue("username")
		password := r.FormValue("password")

		if username == "" || password == "" {
			http.Redirect(w, r, "/login?error=Username+and+password+required", http.StatusFound)
			return
		}

		user, err := h.DB.GetUserByUsername(username)
		if err != nil {
			log.Printf("Error fetching user '%s': %v", username, err)
			http.Redirect(w, r, "/login?error=Invalid+credentials", http.StatusFound)
			return
		}
		if user == nil || !auth.CheckPasswordHash(password, user.PasswordHash) {
			http.Redirect(w, r, "/login?error=Invalid+credentials", http.StatusFound)
			return
		}

		// Create session
		sessionID, expiry, err := auth.CreateSession(h.DB, user.ID, h.Cfg.Session.MaxAge)
		if err != nil {
			log.Printf("Error creating session for user %d: %v", user.ID, err)
			http.Redirect(w, r, "/login?error=Login+failed,+please+try+again", http.StatusFound)
			return
		}

		auth.SetSessionCookie(w, h.Cfg, sessionID, expiry)

		// Redirect after successful login
		redirectURL := r.URL.Query().Get("redirect")
		if redirectURL == "" || redirectURL == "/login" || redirectURL == "/register" {
			redirectURL = "/review" // Default redirect
		}
		http.Redirect(w, r, redirectURL, http.StatusFound)
		return
	}

	http.Error(w, "Method Not Allowed", http.StatusMethodNotAllowed)
}

func (h *WebHandlers) HandleRegisterPage(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodGet {
		// Check if already logged in, redirect if so
		_, err := auth.GetUserIDFromRequest(r, h.DB, h.Cfg)
		if err == nil {
			http.Redirect(w, r, "/review", http.StatusFound) // Redirect to review page
			return
		}
		data := map[string]interface{}{"Title": "Register", "Error": r.URL.Query().Get("error")}
		h.renderTemplate(w, "register.html", data)
		return
	}

	if r.Method == http.MethodPost {
		if err := r.ParseForm(); err != nil {
			http.Error(w, "Failed to parse form", http.StatusBadRequest)
			return
		}
		name := r.FormValue("name")
		username := r.FormValue("username")
		password := r.FormValue("password")

		if name == "" || username == "" || password == "" {
			http.Redirect(w, r, "/register?error=All+fields+are+required", http.StatusFound)
			return
		}
		// Add more validation (password length, username format etc.) here if needed

		// Check if username exists
		existingUser, err := h.DB.GetUserByUsername(username)
		if err != nil {
			log.Printf("Error checking username '%s': %v", username, err)
			http.Redirect(w, r, "/register?error=Registration+failed,+please+try+again", http.StatusFound)
			return
		}
		if existingUser != nil {
			http.Redirect(w, r, "/register?error=Username+already+taken", http.StatusFound)
			return
		}

		hashedPassword, err := auth.HashPassword(password)
		if err != nil {
			log.Printf("Error hashing password for '%s': %v", username, err)
			http.Redirect(w, r, "/register?error=Registration+failed,+please+try+again", http.StatusFound)
			return
		}

		userID, err := h.DB.CreateUser(name, username, hashedPassword)
		if err != nil {
			log.Printf("Error creating user '%s': %v", username, err)
			http.Redirect(w, r, "/register?error=Registration+failed,+please+try+again", http.StatusFound)
			return
		}

		log.Printf("User registered successfully: %s (ID: %d)", username, userID)

		// Automatically log in the user after registration
		sessionID, expiry, err := auth.CreateSession(h.DB, userID, h.Cfg.Session.MaxAge)
		if err != nil {
			log.Printf("Error creating session for new user %d: %v", userID, err)
			// Redirect to login even if session creation fails post-registration
			http.Redirect(w, r, "/login?message=Registration+successful,+please+login", http.StatusFound)
			return
		}
		auth.SetSessionCookie(w, h.Cfg, sessionID, expiry)
		http.Redirect(w, r, "/review", http.StatusFound) // Redirect to review page
		return
	}

	http.Error(w, "Method Not Allowed", http.StatusMethodNotAllowed)
}

func (h *WebHandlers) HandleLogout(w http.ResponseWriter, r *http.Request) {
	cookie, err := r.Cookie(h.Cfg.Session.CookieName)
	if err == nil {
		_ = h.DB.DeleteSession(cookie.Value) // Attempt to delete from DB
	}
	auth.ClearSessionCookie(w, h.Cfg) // Clear cookie regardless
	http.Redirect(w, r, "/login?message=Logged+out+successfully", http.StatusFound)
}

// HandleTrainingPage serves the HTML shell. Data is loaded via API.
func (h *WebHandlers) HandleTrainingPage(w http.ResponseWriter, r *http.Request) {
	// AuthMiddleware ensures user is logged in
	userID := r.Context().Value(UserIDContextKey).(int64)
	user, err := h.DB.GetUserByID(userID)
	if err != nil || user == nil {
		log.Printf("Error fetching user %d for training page: %v", userID, err)
		http.Error(w, "User not found", http.StatusInternalServerError)
		return
	}

	data := map[string]interface{}{
		"Title": "Training",
		"User":  user, // Pass user info to template if needed
	}
	h.renderTemplate(w, "training.html", data)
}

// HandleSettingsPage allows viewing/updating settings like API key
func (h *WebHandlers) HandleSettingsPage(w http.ResponseWriter, r *http.Request) {
	userID := r.Context().Value(UserIDContextKey).(int64)
	user, err := h.DB.GetUserByID(userID)
	if err != nil || user == nil {
		log.Printf("Error fetching user %d for settings page: %v", userID, err)
		http.Error(w, "User not found", http.StatusInternalServerError)
		return
	}

	currentSettings, err := h.DB.GetUserSettings(userID)
	if err != nil {
		log.Printf("Error getting settings for user %d: %v", userID, err)
		http.Error(w, "Could not load settings", http.StatusInternalServerError)
		return
	}
	// Ensure currentSettings is not nil (if GetUserSettings returns nil on no row)
	if currentSettings == nil {
		currentSettings = &models.UserSettings{UserID: userID} // Should not happen with new GetUserSettings logic
	}

	if r.Method == http.MethodGet {
		apiKeyIsSet := currentSettings.GeminiAPIKey != ""

		data := map[string]interface{}{
			"Title":       "Settings",
			"User":        user,
			"APIKeyIsSet": apiKeyIsSet,     // Still useful indicator
			"Settings":    currentSettings, // Pass the whole settings object
			"Message":     r.URL.Query().Get("message"),
			"Error":       r.URL.Query().Get("error"),
		}
		h.renderTemplate(w, "settings.html", data)
		return
	}

	if r.Method == http.MethodPost {
		if err := r.ParseForm(); err != nil {
			http.Error(w, "Failed to parse form", http.StatusBadRequest)
			return
		}

		// Create a settings struct to hold the new values, starting with current ones
		updatedSettings := *currentSettings // Make a copy to update

		// --- Update values from form ---
		apiKey := r.FormValue("geminiApiKey")
		// Only update key if user provides a non-empty value or specifically clears it?
		// Let's assume empty means "clear", otherwise update if changed.
		// The current logic updates if len > 5 and len < 100 OR if empty.
		if apiKey == "" {
			updatedSettings.GeminiAPIKey = "" // Clear the key
		} else if len(apiKey) > 5 && len(apiKey) < 100 { // Basic validation
			updatedSettings.GeminiAPIKey = apiKey
		} else if apiKey != "" {
			// Provided but invalid format - maybe redirect with error instead of ignoring?
			http.Redirect(w, r, "/settings?error=Invalid+API+key+format+(must+be+empty+or+valid)", http.StatusFound)
			return
		}
		// If user didn't provide the field, updatedSettings.GeminiAPIKey retains the current value

		updatedSettings.DictBaseURL = r.FormValue("dictBaseUrl")
		// Basic URL validation (optional but recommended)
		if _, err := url.ParseRequestURI(updatedSettings.DictBaseURL); err != nil && updatedSettings.DictBaseURL != "" {
			http.Redirect(w, r, "/settings?error=Invalid+Dictionary+Base+URL+format", http.StatusFound)
			return
		}

		updatedSettings.AllowFragmentURLList = r.FormValue("allowFragmentUrlList") // Store as submitted (comma-separated)
		// No complex validation here, UserScript will parse

		numLimitStr := r.FormValue("wordsNumberLimit")
		if numLimit, err := strconv.Atoi(numLimitStr); err == nil && numLimit > 0 && numLimit < 20 {
			updatedSettings.WordsNumberLimit = numLimit
		} else if numLimitStr != "" { // Only error if non-empty and invalid
			http.Redirect(w, r, "/settings?error=Invalid+Word+Number+Limit+(must+be+a+number+between+1+and+19)", http.StatusFound)
			return
		}

		lenLimitStr := r.FormValue("wordsLengthLimit")
		if lenLimit, err := strconv.Atoi(lenLimitStr); err == nil && lenLimit > 5 && lenLimit < 100 {
			updatedSettings.WordsLengthLimit = lenLimit
		} else if lenLimitStr != "" {
			http.Redirect(w, r, "/settings?error=Invalid+Word+Length+Limit+(must+be+a+number+between+6+and+99)", http.StatusFound)
			return
		}

		updatedSettings.HighlightColor = r.FormValue("highlightColor")
		// Basic color validation (optional) - check for rgba, hex, etc.
		// For now, trust user input or rely on browser color picker validation.

		// --- Save updated settings ---
		err = h.DB.SaveUserSettings(&updatedSettings)
		if err != nil {
			log.Printf("Error saving settings for user %d: %v", userID, err)
			http.Redirect(w, r, "/settings?error=Failed+to+save+settings", http.StatusFound)
		} else {
			http.Redirect(w, r, "/settings?message=Settings+saved+successfully", http.StatusFound)
		}
		return
	}

	http.Error(w, "Method Not Allowed", http.StatusMethodNotAllowed)
}

func (h *WebHandlers) HandlePodcastUploadPage(w http.ResponseWriter, r *http.Request) {
	// AuthMiddleware ensures user is logged in
	userID := r.Context().Value(UserIDContextKey).(int64)
	user, err := h.DB.GetUserByID(userID)
	if err != nil || user == nil {
		log.Printf("Error fetching user %d for podcast upload page: %v", userID, err)
		http.Error(w, "User not found", http.StatusInternalServerError)
		return
	}

	// Potential messages from redirects (though unlikely with JS approach)
	message := r.URL.Query().Get("message")
	errorMsg := r.URL.Query().Get("error")

	data := map[string]interface{}{
		"Title":   "Upload Podcast",
		"User":    user, // Pass user info if needed in template
		"Message": message,
		"Error":   errorMsg,
	}
	h.renderTemplate(w, "podcast_upload.html", data)
}

func (h *WebHandlers) HandlePodcastListPage(w http.ResponseWriter, r *http.Request) {
	// AuthMiddleware ensures user is logged in
	userID := r.Context().Value(UserIDContextKey).(int64)
	user, err := h.DB.GetUserByID(userID)
	if err != nil || user == nil {
		log.Printf("Error fetching user %d for podcast list page: %v", userID, err)
		http.Error(w, "User not found", http.StatusInternalServerError)
		return
	}

	data := map[string]interface{}{
		"Title": "My Podcasts",
		"User":  user,
	}
	h.renderTemplate(w, "podcast_list.html", data)
}

func (h *WebHandlers) HandlePodcastPlayPage(w http.ResponseWriter, r *http.Request) {
	// AuthMiddleware ensures user is logged in
	userID := r.Context().Value(UserIDContextKey).(int64)
	user, err := h.DB.GetUserByID(userID) // To display username or for other checks
	if err != nil || user == nil {
		http.Error(w, "User not found", http.StatusUnauthorized)
		return
	}

	// Get podcast ID from context using router helper
	podcastID := router.GetPathParam(r.Context())
	if podcastID == "" {
		http.Error(w, "Missing podcast ID", http.StatusBadRequest)
		return
	}
	if _, err := uuid.Parse(podcastID); err != nil {
		http.Error(w, "Invalid podcast ID format", http.StatusBadRequest)
		return
	}

	// Fetch minimal data to ensure podcast exists and belongs to user, and is completed
	// The full data including transcript will be fetched by client-side JS
	podcast, err := h.DB.GetPodcastByIDForUser(userID, podcastID)
	if err != nil {
		log.Printf("Web HandlePodcastPlayPage: Error fetching podcast %s for user %d: %v", podcastID, userID, err)
		if strings.Contains(err.Error(), "not found") {
			http.Error(w, "Podcast not found or access denied.", http.StatusNotFound)
		} else {
			http.Error(w, "Error retrieving podcast.", http.StatusInternalServerError)
		}
		return
	}

	if podcast.Status != models.StatusCompleted {
		http.Error(w, fmt.Sprintf("Podcast transcription is not yet complete (Status: %s). Please wait.", podcast.Status), http.StatusPreconditionFailed)
		return
	}

	data := map[string]interface{}{
		"Title":     fmt.Sprintf("Playing: %s - %s", podcast.Series, podcast.Episode),
		"User":      user,
		"PodcastID": podcastID, // Pass ID to the template for JS to use
		"Podcast":   podcast,   // Pass basic metadata for initial display
	}
	h.renderTemplate(w, "podcast_play.html", data)
}

func (h *WebHandlers) HandleReviewPage(w http.ResponseWriter, r *http.Request) {
	userID := r.Context().Value(UserIDContextKey).(int64)
	user, err := h.DB.GetUserByID(userID)
	if err != nil || user == nil {
		http.Error(w, "User not found", http.StatusUnauthorized)
		return
	}

	data := map[string]interface{}{
		"Title": "Review Marked Words",
		"User":  user,
		// Data will be fetched by client-side JS
	}
	h.renderTemplate(w, "review.html", data)
}
