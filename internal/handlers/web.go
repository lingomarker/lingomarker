package handlers

import (
	"html/template"
	"lingomarker/internal/auth"
	"lingomarker/internal/config"
	"lingomarker/internal/database"
	"lingomarker/internal/models"
	"log"
	"net/http"
	"path/filepath"
	"strings"
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
			http.Redirect(w, r, "/training", http.StatusFound) // Redirect to training page
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
			redirectURL = "/training" // Default redirect
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
			http.Redirect(w, r, "/training", http.StatusFound) // Redirect to training page
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
		http.Redirect(w, r, "/training", http.StatusFound) // Redirect to training page
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
	// AuthMiddleware ensures user is logged in
	userID := r.Context().Value(UserIDContextKey).(int64)
	user, err := h.DB.GetUserByID(userID) // Get user details
	if err != nil || user == nil {
		log.Printf("Error fetching user %d for settings page: %v", userID, err)
		http.Error(w, "User not found", http.StatusInternalServerError)
		return
	}

	settings, err := h.DB.GetUserSettings(userID)
	if err != nil {
		log.Printf("Error getting settings for user %d: %v", userID, err)
		http.Error(w, "Could not load settings", http.StatusInternalServerError)
		return
	}
	// Don't send the actual key back to the GET request for security.
	// Indicate if a key is set or not.
	apiKeyIsSet := settings != nil && settings.GeminiAPIKey != ""

	if r.Method == http.MethodGet {
		data := map[string]interface{}{
			"Title":       "Settings",
			"User":        user,
			"APIKeyIsSet": apiKeyIsSet,
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
		apiKey := r.FormValue("geminiApiKey")
		// Add basic validation if needed
		if len(apiKey) > 5 && len(apiKey) < 100 { // Very basic check
			newSettings := &models.UserSettings{
				UserID:       userID,
				GeminiAPIKey: apiKey,
			}
			err = h.DB.SaveUserSettings(newSettings)
			if err != nil {
				log.Printf("Error saving settings for user %d: %v", userID, err)
				http.Redirect(w, r, "/settings?error=Failed+to+save+API+key", http.StatusFound)
			} else {
				http.Redirect(w, r, "/settings?message=API+key+saved+successfully", http.StatusFound)
			}
		} else if apiKey == "" {
			// Allow clearing the key
			newSettings := &models.UserSettings{
				UserID:       userID,
				GeminiAPIKey: "", // Save empty string
			}
			err = h.DB.SaveUserSettings(newSettings)
			if err != nil {
				log.Printf("Error clearing API key for user %d: %v", userID, err)
				http.Redirect(w, r, "/settings?error=Failed+to+clear+API+key", http.StatusFound)
			} else {
				http.Redirect(w, r, "/settings?message=API+key+cleared", http.StatusFound)
			}
		} else {
			http.Redirect(w, r, "/settings?error=Invalid+API+key+format", http.StatusFound)
		}
		return
	}

	http.Error(w, "Method Not Allowed", http.StatusMethodNotAllowed)
}
